const test = require('node:test')
const assert = require('node:assert/strict')
const { doubaoPage, mapDoubaoBounds, doubaoReferenceCount, doubaoReferences, createDoubaoWorkflow } = require('../../src/automation/doubao-workflow')

function fixture(scale = 1, { welcome = true, question = '', complete = false, rotation = 0 } = {}) {
  const b = values => `[${values.slice(0, 2).map(v => Math.round(v * scale))}][${values.slice(2).map(v => Math.round(v * scale))}]`
  const node = (id, bounds, extra = '') => `<node package="com.larus.nova" resource-id="com.larus.nova:id/${id}" bounds="${b(bounds)}" visible-to-user="true" ${extra}/>`
  return `<hierarchy rotation="${rotation}"><node package="com.larus.nova" resource-id="com.larus.nova:id/chat_root" bounds="${b([0, 0, 1080, 2400])}">
    ${node('message_list', [0, 260, 1080, 2000])}${node('input_text', [150, 2180, 805, 2310], 'class="android.widget.EditText" text="发消息或按住说话..."')}
    ${welcome ? node('larus_mode_switch_welcome_title', [0, 790, 1080, 890], 'text="有什么我能帮你的吗？"') : ''}
    ${question ? node('content_view', [320, 290, 1040, 430], `text="${question}"`) : ''}
    ${complete ? node('msg_action_copy', [70, 1800, 170, 1900], 'content-desc="复制"') + node('msg_action_regenerate', [900, 1800, 1000, 1900], 'content-desc="重新生成"') : ''}
  </node></hierarchy>`
}

for (const scale of [1, 2 / 3]) {
  test(`豆包完整来源编号逐条归档，排除视口裁短的末条 (${scale})`, () => {
    const node=(id,text,b)=>`<node package="com.larus.nova" resource-id="com.larus.nova:id/${id}" text="${text}" bounds="[${b.slice(0,2).map(v=>Math.round(v*scale))}][${b.slice(2).map(v=>Math.round(v*scale))}]"/>`
    const sources=node('tv_reference_title','搜索 4 个关键词，参考 3 篇资料',[77,600,780,670])
      +node('tv_reference_index','1.',[77,800,146,860])+node('tv_reference_content','文献甲',[170,800,1000,860])
      +node('tv_reference_index','2.',[77,900,146,960])+node('tv_reference_content','药品说明乙',[170,900,1000,960])
      +node('tv_reference_index','3.',[77,1960,146,2000])+node('tv_reference_content','文献丙',[170,1960,1000,2000])
    const page=doubaoPage(fixture(scale).replace('</hierarchy>',sources+'</hierarchy>'))
    assert.equal(doubaoReferenceCount(page),3)
    assert.deepEqual(doubaoReferences(page),[{index:1,title:'文献甲'},{index:2,title:'药品说明乙'}])
    assert.throws(()=>doubaoReferenceCount(doubaoPage(fixture(scale).replace('</hierarchy>',node('tv_reference_title','未知资料格式',[77,600,780,670])+'</hierarchy>'))),/格式尚未适配/)
  })
}

for (const scale of [1, 2 / 3]) {
  test(`豆包按目标包解析竖屏视口并映射不同物理尺寸 (${scale})`, () => {
    const page = doubaoPage(fixture(scale))
    assert.equal(page.clean, true)
    assert.equal(page.size.width, Math.round(1080 * scale))
    assert.deepEqual(mapDoubaoBounds(page.bounds, page.size, {width: 1080, height: 2400}), [0, Math.round(260 * scale) / (2400 * scale) * 2400, 1080, Math.round(2000 * scale) / (2400 * scale) * 2400].map(Math.round))
    const reply = doubaoPage(fixture(scale, {welcome: false, question: '测试问题', complete: true}), '测试问题')
    assert.equal(reply.clean, false)
    assert.equal(reply.complete, true)
    assert.equal(reply.questionVisible, true)
    assert.equal(doubaoPage(fixture(scale, {welcome: false, question: '其他问题'}), '测试问题').questionVisible, false)
  })
}

test('豆包拒绝错误包、横屏、分屏和失真的物理/逻辑映射', () => {
  assert.throws(() => doubaoPage(fixture().replaceAll('com.larus.nova', 'other.app')), /豆包/)
  assert.throws(() => doubaoPage(fixture(1, {rotation: 1})), /竖屏/)
  assert.throws(() => doubaoPage(fixture().replace('[0,0][1080,2400]', '[0,700][1080,2400]')), /视口/)
  assert.throws(() => mapDoubaoBounds([0,260,1080,2000], {width:1080,height:2400}, {width:1080,height:1800}), /比例/)
})

test('豆包新会话无法确认时不输入，不重放新会话点击', async () => {
  let clicks = 0; let inputs = 0; let clock = 0
  const old = fixture(1, {welcome:false, question:'旧问题'})
    .replace('</hierarchy>', '<node package="com.larus.nova" resource-id="com.larus.nova:id/larus_chat_top_left_create_new_cvs" bounds="[140,115][260,235]" clickable="true"/></hierarchy>')
  const png = await require('sharp')({create:{width:1080,height:2400,channels:3,background:'#ffffff'}}).png().toBuffer()
  const flow = createDoubaoWorkflow({source:async()=>old, ui:{currentApp:async()=>({package:'com.larus.nova'}),sendKeys:async()=>{inputs++}}, tap:async()=>{clicks++}, screenshot:async()=>png, log:()=>{}, delay:async()=>{clock+=5000}, now:()=>clock})
  await assert.rejects(flow.submitQuestion('测试问题'), /新会话/)
  assert.equal(clicks,1); assert.equal(inputs,0)
})

test('豆包发送前两次精确回读，只提交一次并先记录提交状态', async () => {
  const png = await require('sharp')({create:{width:1080,height:2400,channels:3,background:'#fff'}}).png().toBuffer()
  let xml = fixture(); let sent = 0; let checkpoint = false
  const flow = createDoubaoWorkflow({source:async()=>xml, screenshot:async()=>png, delay:async()=>{},
    ui:{currentApp:async()=>({package:'com.larus.nova'}), sendKeys:async text=>{
      xml = fixture().replace('text="发消息或按住说话..."', `text="${text}"`).replace('</hierarchy>', '<node package="com.larus.nova" resource-id="com.larus.nova:id/action_send" content-desc="发送" bounds="[930,2160][1040,2320]"/></hierarchy>')
    }}, tap:async x=>{ if(x>900) { assert.equal(checkpoint,true); sent++ } }})
  const result = await flow.submitQuestion('测试问题', async()=>{checkpoint=true})
  assert.equal(sent,1); assert.equal(result.doubao_input_verified,true)
})

test('豆包失去前台后停止输入与点击', async () => {
  const png = await require('sharp')({create:{width:1080,height:2400,channels:3,background:'#fff'}}).png().toBuffer()
  let actions = 0
  const flow = createDoubaoWorkflow({source:async()=>fixture(), screenshot:async()=>png, delay:async()=>{},
    ui:{currentApp:async()=>({package:'other.app'}),sendKeys:async()=>{actions++}},tap:async()=>{actions++}})
  await assert.rejects(flow.submitQuestion('测试问题'), /前台应用不是豆包/)
  assert.equal(actions,0)
})

test('豆包完整滚动采集保留问题、所有正文像素和悬浮按钮下的末尾，物理尺寸独立映射', async () => {
  const sharp = require('sharp')
  const { buildReplyImages } = require('../../src/automation/capture-primitives')
  const { cropImage, imageRegionsStable } = require('../../src/automation/images')
  const scale = 1 / 3
  const physical = {width:270, height:600}
  const base = doubaoPage(fixture(scale))
  const b = mapDoubaoBounds(base.bounds, base.size, physical)
  const viewportHeight = b[3] - b[1]
  const contentHeight = viewportHeight + 475
  const shapes = Array.from({length:Math.ceil(contentHeight/9)}, (_, i) => {
    const x = 4 + i * 17 % 24
    return `<rect x="${x}" y="${i*9+2}" width="${240 - i*17%50}" height="${2+i%3}" fill="rgb(${i*37%130},${i*53%130},${i*71%130})"/>`
  }).join('')
  const document = await sharp(Buffer.from(`<svg width="270" height="${contentHeight}"><rect width="100%" height="100%" fill="white"/>${shapes}</svg>`)).png().toBuffer()
  const maximum = contentHeight - viewportHeight
  let offset = maximum; let clock = 0; let submissions = 0
  const source = async () => {
    let xml = fixture(scale, {welcome:false,question:offset===0?'测试问题':'',complete:offset===maximum})
    if(offset < maximum) xml = xml.replace('</hierarchy>', '<node package="com.larus.nova" resource-id="com.larus.nova:id/fast_button_icon" content-desc="回到底部" bounds="[160,610][200,650]"/></hierarchy>')
    return xml
  }
  const screenshot = async () => {
    const frame = await cropImage(document,[0,offset,physical.width,offset+viewportHeight])
    return sharp({create:{...physical,channels:3,background:'#fff'}}).composite([{input:frame,left:0,top:b[1]}]).png().toBuffer()
  }
  const flow = createDoubaoWorkflow({source,screenshot,delay:async()=>{clock+=2000},now:()=>clock,
    ui:{currentApp:async()=>({package:'com.larus.nova'}),sendKeys:async()=>{submissions++}},
    swipe:async(_x, from, to)=>{offset=Math.max(0,Math.min(maximum,offset+Math.round((from-to)*physical.height/base.size.height)))}})
  const result = await flow.captureAnswer('测试问题',180000)
  assert.equal(submissions,0)
  assert.equal(result.captureMetadata.doubao_capture_complete,true)
  assert.equal(result.transitions.length,result.frames.length-1)
  assert.ok(result.transitions.every(t=>t.verified))
  assert.equal(result.seamRecords.at(-1).method,'same_raw_png_terminal_extension')
  const images=await buildReplyImages(result.frames,{transitions:result.transitions})
  assert.equal(images.length,1)
  const metadata=await sharp(images[0]).metadata()
  // The overlap matcher can keep a few safe repeated rows. Neither edge may
  // lose any content; check both against the original synthetic document.
  assert.ok(metadata.height>=contentHeight)
  assert.equal(await imageRegionsStable(await cropImage(images[0],[0,0,270,100]),await cropImage(document,[0,0,270,100])),true)
  assert.equal(await imageRegionsStable(await cropImage(images[0],[0,metadata.height-100,270,metadata.height]),await cropImage(document,[0,contentHeight-100,270,contentHeight])),true)
})

for (const scale of [1, 1.5]) {
  test(`豆包吸顶资料标题必须排除后才允许验证接缝 (${scale})`, async () => {
    const sharp=require('sharp')
    const {cropImage,verifyReplyFrameOverlap}=require('../../src/automation/images')
    const width=240*scale; const height=400*scale; const shift=200*scale; const header=50*scale
    const shapes=Array.from({length:100},(_,i)=>`<rect x="${10*scale}" y="${i*8*scale}" width="${(215-i*13%40)*scale}" height="${(2+i%4)*scale}" fill="rgb(${i*37%100},${i*53%150},${i*71%180})"/>`).join('')
    const document=await sharp(Buffer.from(`<svg width="${width}" height="${height*2}"><rect width="100%" height="100%" fill="white"/>${shapes}</svg>`)).png().toBuffer()
    const previous=await cropImage(document,[0,0,width,height])
    const cleanNext=await cropImage(document,[0,shift,width,shift+height])
    const overlay=await sharp({create:{width,height:header,channels:3,background:'#fff'}}).png().toBuffer()
    const pinned=await sharp(cleanNext).composite([{input:overlay,left:0,top:0}]).png().toBuffer()
    await assert.rejects(verifyReplyFrameOverlap(previous,pinned,height-shift),/连续性/)
    const next=await cropImage(pinned,[0,header,width,height])
    assert.equal(await verifyReplyFrameOverlap(previous,next,height-shift-header),height-shift-header)
  })
}
