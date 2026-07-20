const { spawn } = require("node:child_process");
const readline = require("node:readline");
const { sleep } = require("./utils");
const {
  bundledU2Executable,
  pythonProjectDirectory
} = require("../runtime-paths");

class U2ClientError extends Error {
  constructor(message, { method, cause } = {}) {
    super(message, { cause });
    this.name = "U2ClientError";
    this.method = method;
  }
}

class U2RequestTimeoutError extends U2ClientError {
  constructor(method, timeout) {
    super(`Python uiautomator2 请求超时：${method}（${timeout}ms）`, {
      method
    });
    this.name = "U2RequestTimeoutError";
  }
}

const SEND_KEYS_TIMEOUT_MS = 45_000;
// A frozen app may spend several seconds loading ONNX Runtime and models on
// the first OCR request. Later calls reuse the same engine and are much faster.
const OCR_TIMEOUT_MS = 60_000;
const READ_RETRY_DELAY_MS = 500;

function transientReadFailure(error) {
  if (error instanceof U2RequestTimeoutError) return true;
  return /Remote end closed connection|ECONNRESET|ECONNREFUSED|broken pipe|connection reset|请求超时|进程已退出|尚未启动|已停止/i.test(
    String(error?.message || error)
  );
}

function developmentCommand(root) {
  return {
    command: process.env.UV_EXECUTABLE || "uv",
    args: ["run", "--locked", "python", "-m", "geoauto_u2.bridge"],
    cwd: pythonProjectDirectory(root)
  };
}

function packagedCommand(options) {
  return {
    command: bundledU2Executable({
      isPackaged: true,
      resourcesPath: options.resourcesPath,
      root: options.root
    }),
    args: [],
    cwd: options.resourcesPath
  };
}

function utf8ProcessEnvironment(environment = process.env) {
  return {
    ...environment,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8"
  };
}

class U2Client {
  constructor(options) {
    this.options = options;
    this.process = null;
    this.serial = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
    this.startPromise = null;
  }

  log(message) {
    this.options.log?.(`[uiautomator2] ${message}`);
  }

  command() {
    if (this.options.command) return this.options.command;
    return this.options.isPackaged
      ? packagedCommand(this.options)
      : developmentCommand(this.options.root);
  }

  async start(serial) {
    this.serial = serial;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start(serial).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async #start(serial) {
    if (this.process) return;
    const launch = this.command();
    this.stopping = false;
    const child = spawn(launch.command, launch.args || [], {
      cwd: launch.cwd,
      env: utf8ProcessEnvironment({
        ...process.env,
        ADBUTILS_ADB_PATH: this.options.adbPath
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.process = child;
    child.once("error", (error) =>
      this.#processEnded(
        child,
        new U2ClientError(`无法启动Python uiautomator2：${error.message}`, {
          cause: error
        })
      )
    );
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal=${signal}` : `code=${code}`;
      this.#processEnded(
        child,
        new U2ClientError(`Python uiautomator2进程已退出（${suffix}）`)
      );
    });
    readline
      .createInterface({ input: child.stdout })
      .on("line", (line) => this.#handleLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) this.log(line);
    });
    try {
      await this.#requestOnce(
        "connect",
        { serial, adb_path: this.options.adbPath },
        this.options.startTimeout || 35_000
      );
      this.log(`已连接设备 ${serial}`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`忽略非协议输出：${line}`);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else
      pending.reject(
        new U2ClientError(
          `Python uiautomator2 ${pending.method}失败：${message.error?.message || "未知错误"}`,
          { method: pending.method }
        )
      );
  }

  #rejectPending(error) {
    const wasStopping = this.stopping;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        wasStopping ? new U2ClientError("Python uiautomator2已停止") : error
      );
    }
    this.pending.clear();
  }

  #processEnded(child, error) {
    if (this.process !== child) return;
    this.process = null;
    this.#rejectPending(error);
  }

  #requestOnce(
    method,
    params = {},
    timeout = this.options.requestTimeout || 7_000
  ) {
    if (!this.process?.stdin?.writable)
      return Promise.reject(
        new U2ClientError("Python uiautomator2尚未启动", { method })
      );
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new U2RequestTimeoutError(method, timeout));
      }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      this.process.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new U2ClientError(
              `发送Python uiautomator2请求失败：${error.message}`,
              { method, cause: error }
            )
          );
        }
      );
    });
  }

  async request(method, params = {}, { timeout, retryRead = false } = {}) {
    let readRetries = 0;
    while (true) {
      try {
        return await this.#requestOnce(method, params, timeout);
      } catch (error) {
        if (!retryRead) {
          await this.restart().catch(() => {});
          throw error;
        }
        const canRetry = readRetries === 0
          || (readRetries < 2 && transientReadFailure(error));
        if (!canRetry) throw error;
        readRetries += 1;
        this.log(
          `${method}失败，重启sidecar后仅重试本次只读请求（${readRetries}/2）：${error.message}`
        );
        await this.restart();
        await sleep(this.options.readRetryDelay ?? READ_RETRY_DELAY_MS);
      }
    }
  }

  async restart() {
    const serial = this.serial;
    await this.stop();
    if (!serial)
      throw new U2ClientError("缺少设备序列号，无法重启Python uiautomator2");
    return this.start(serial);
  }

  dumpHierarchy() {
    return this.request(
      "dump_hierarchy",
      { compressed: false, max_depth: 70 },
      { retryRead: true }
    );
  }

  health() {
    return this.request("health", {}, { retryRead: true });
  }

  currentApp() {
    return this.request("current_app", {}, { retryRead: true });
  }

  foregroundWindow() {
    return this.request("foreground_window", {}, { retryRead: true });
  }

  prepareDevicePower() {
    return this.request("prepare_device_power", {}, { timeout: 15_000 });
  }

  deviceLockState() {
    return this.request("device_lock_state", {}, { retryRead: true });
  }

  restoreDevicePower(stayAwakeOriginal) {
    return this.request("restore_device_power", {
      stay_awake_original: stayAwakeOriginal ?? null
    });
  }

  ocrRecognize(image, {
    region,
    minConfidence = 0,
    useDetection = true,
    useClassification = false,
    useRecognition = true,
    timeout = OCR_TIMEOUT_MS
  } = {}) {
    if (!Buffer.isBuffer(image) || !image.length)
      return Promise.reject(new U2ClientError("OCR需要非空的PNG或JPEG Buffer", { method: "ocr_recognize" }));
    return this.request("ocr_recognize", {
      image_base64: image.toString("base64"),
      ...(region ? { region } : {}),
      min_confidence: minConfidence,
      use_detection: useDetection,
      use_classification: useClassification,
      use_recognition: useRecognition
    }, { timeout, retryRead: true });
  }

  click(x, y) {
    return this.request("click", { x: Math.round(x), y: Math.round(y) });
  }

  sendKeys(text, { clear = false, timeout = SEND_KEYS_TIMEOUT_MS } = {}) {
    return this.request("send_keys", { text: String(text), clear }, { timeout });
  }

  setFocusedText(text, { timeout = SEND_KEYS_TIMEOUT_MS } = {}) {
    return this.request("set_focused_text", { text: String(text) }, { timeout });
  }

  press(key) {
    return this.request("press", { key });
  }

  appStart(packageName) {
    return this.request(
      "app_start",
      { package: packageName },
      { timeout: 20_000 }
    );
  }

  async stop() {
    const child = this.process;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1_000))
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 1_000))
      ]);
    }
    if (this.process === child) {
      this.process = null;
      this.#rejectPending(new U2ClientError("Python uiautomator2已停止"));
    }
    this.stopping = false;
  }
}

module.exports = {
  U2Client,
  U2ClientError,
  U2RequestTimeoutError,
  SEND_KEYS_TIMEOUT_MS,
  OCR_TIMEOUT_MS,
  READ_RETRY_DELAY_MS,
  transientReadFailure,
  developmentCommand,
  packagedCommand,
  utf8ProcessEnvironment
};
