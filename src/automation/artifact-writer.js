const fs = require('node:fs/promises')
const path = require('node:path')
const { buildReplyImages } = require('./capture-primitives')
const { referenceProductsCaptureComplete } = require('./reference-products')
const { writeReplySeamDiagnostics } = require('./seam-diagnostics')

const ARTIFACT_LAYOUT_VERSION = 8

function createArtifactWriter({
  defaultCaptureMethod,
  getMaxLongImageHeight,
  screenshot,
  normalizedHierarchy,
  observerMetadata,
  getBatchEventLog,
  log,
}) {
  async function saveArtifacts({ artifacts, stem, question, status, xml, meta, stitch = true, frame = null, captureMethod = defaultCaptureMethod, observerBaseline, recoveryBaseline }) {
    const deliveryDirectory = artifacts.deliveryDirectory
    const diagnosticDirectory = artifacts.diagnosticDirectory
    await Promise.all([
      fs.mkdir(deliveryDirectory, { recursive: true }),
      fs.mkdir(diagnosticDirectory, { recursive: true }),
    ])
    const xmlPath = path.join(diagnosticDirectory, `${stem}.xml`)
    const metadataPath = path.join(diagnosticDirectory, `${stem}.json`)
    const performancePath = path.join(diagnosticDirectory, '性能分析.json')
    let screenshotPath = path.join(deliveryDirectory, `${stem}.png`)
    let resultMeta = { ...meta }
    if (stitch) {
      const replyCaptureStarted = Date.now()
      const capture = await captureMethod(question)
      const { frames, transitions, bounds, recaptureCount, fullRetryCount, fallbackReasons, topNavigationMs, questionLocated, questionFullyVisible, evidenceEmbedded, evidenceExpanded, productDetected, products, productCaptureAttempts, productCaptureMs, captureMetadata = {} } = capture
      const seamArtifacts = await writeReplySeamDiagnostics(diagnosticDirectory, capture)
      log(`capture: 接缝汇总已保存 ${seamArtifacts.summary}（帧=${seamArtifacts.details.frame_count}，接缝=${seamArtifacts.details.transition_count}/${seamArtifacts.details.expected_transition_count}，异常证据=${seamArtifacts.diagnostics.length}组）`)
      if (!referenceProductsCaptureComplete({ detected: productDetected, products })) {
        const error = new Error('检测到推荐药品入口，但药品截图未完整完成')
        error.replySeamDiagnostics = seamArtifacts
        throw error
      }
      const seamsTotal = Math.max(0, frames.length - 1)
      const seamsVerified = transitions.filter(transition => transition.verified).length
      const continuityVerified = transitions.length === seamsTotal && seamsVerified === seamsTotal
      let images
      try {
        images = await buildReplyImages(frames, { transitions, maxHeight: getMaxLongImageHeight() })
      } catch (error) {
        error.replySeamDiagnostics = seamArtifacts
        throw error
      }
      const replyCaptureMs = Date.now() - replyCaptureStarted
      const paths = []
      for (const [index, image] of images.entries()) { const file = path.join(deliveryDirectory, `${stem}_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
      screenshotPath = paths[0]
      resultMeta = {
        ...resultMeta,
        stitched_pages: frames.length,
        screenshot_parts: paths,
        chat_bounds: bounds,
        reply_capture_mode: continuityVerified ? 'verified_overlap_long_image' : 'safe_overlap_long_image',
        reply_continuity_verified: continuityVerified,
        reply_seams_total: seamsTotal,
        reply_seams_verified: seamsVerified,
        reply_seams_with_safe_overlap: seamsTotal - seamsVerified,
        reply_recapture_count: recaptureCount,
        reply_seam_summary: seamArtifacts.summary,
        reply_seam_diagnostic_directories: seamArtifacts.diagnostics.map(item => item.directory),
        reply_frame_transition_invariant_valid: seamArtifacts.details.frame_transition_invariant_valid,
        reply_full_retry_count: fullRetryCount,
        reply_top_navigation_ms: topNavigationMs,
        ...(questionLocated !== undefined ? { reply_question_located: questionLocated } : {}),
        ...(questionFullyVisible !== undefined ? { reply_question_fully_visible: questionFullyVisible } : {}),
        reply_evidence_embedded: evidenceEmbedded,
        reply_evidence_expanded: evidenceExpanded,
        reply_capture_ms: replyCaptureMs,
        reference_products_detected: productDetected,
        reference_products_capture_required: productDetected,
        reference_products_inline_capture: Boolean(products),
        reference_products_restore_required: false,
        reference_products_terminal_sequence: Boolean(products),
        reference_products_retry_count: Math.max(0, productCaptureAttempts - (productDetected ? 1 : 0)),
        reference_products_post_scan_swipes: 0,
        reference_products_capture_ms: productCaptureMs,
        ...captureMetadata,
        ...(fallbackReasons.length ? { reply_fallback_reason: fallbackReasons.join('；') } : {}),
        long_image_max_height: getMaxLongImageHeight(),
      }
      log(`capture: 回答截图完成，帧=${frames.length}，精确接缝=${seamsVerified}/${seamsTotal}，安全重复接缝=${seamsTotal - seamsVerified}，重采=${recaptureCount}，模式=${resultMeta.reply_capture_mode}，耗时=${replyCaptureMs}ms`)
      if (products) {
        const paths = []
        for (const [index, image] of products.images.entries()) { const file = path.join(deliveryDirectory, `${stem}_参考药品_${String(index + 1).padStart(3, '0')}.png`); await fs.writeFile(file, image); paths.push(file) }
        Object.assign(resultMeta, {
          reference_products_screenshot: paths[0],
          reference_products_parts: paths,
          reference_products_pages: products.pages,
          reference_products_capture_mode: products.firstViewportStandalone ? 'standalone_first_viewport_then_verified_overlap_stitch' : (products.continuityVerified ? 'verified_overlap_stitch' : 'separate_viewports'),
          reference_products_continuity_verified: products.continuityVerified,
          reference_products_first_viewport_standalone: products.firstViewportStandalone,
          reference_products_images_ready: products.imagesReady,
          reference_products_unloaded_images: products.unloaded,
          reference_products_confirmed_end: products.confirmedEnd,
          reference_products_first_viewport_included: products.firstViewportIncluded,
          reference_products_capture_complete: products.firstViewportIncluded && products.imagesReady && products.confirmedEnd && products.continuityVerified,
          reference_products_calibrated_seams: products.calibratedSeams,
          reference_products_trigger_refreshed: products.triggerRefreshed,
        })
      }
    } else await fs.writeFile(screenshotPath, frame || await screenshot())
    await fs.writeFile(xmlPath, xml || await normalizedHierarchy(), 'utf8')
    resultMeta = { ...resultMeta, ...observerMetadata(observerBaseline, recoveryBaseline) }
    await fs.writeFile(metadataPath, JSON.stringify({
      question,
      status,
      created_at: new Date().toISOString().replace(/\.\d{3}Z$/, ''),
      artifact_layout_version: ARTIFACT_LAYOUT_VERSION,
      delivery_directory: deliveryDirectory,
      diagnostic_directory: diagnosticDirectory,
      event_log: path.join(diagnosticDirectory, '执行日志.jsonl'),
      batch_event_log: getBatchEventLog()?.filePath || null,
      performance_report: performancePath,
      screenshot: screenshotPath,
      hierarchy: xmlPath,
      ...resultMeta,
    }, null, 2), 'utf8')
    return {
      screenshot: screenshotPath,
      hierarchy: xmlPath,
      metadata: metadataPath,
      performance: performancePath,
      ...(resultMeta.reply_seam_summary ? { seam_summary: resultMeta.reply_seam_summary } : {}),
    }
  }
  

  return { saveArtifacts }
}

module.exports = { createArtifactWriter, ARTIFACT_LAYOUT_VERSION }
