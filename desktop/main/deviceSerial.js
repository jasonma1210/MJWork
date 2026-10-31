// L5 验证反馈层（2026-10-31）：抓串口输出，回答「烧完到底跑起来了没有」。
//
// 为什么需要这一层：L4 的两道验收（esptool 退出码 + verify 逐字节比对）都只证明
// **字节写对了**，证明不了**固件能跑**。真实故障里最常见的一类恰恰是「烧录成功但不开机」——
// 分区表不对、app 偏移写错、固件是给另一块芯片编的、NVS 里留了不兼容的旧配置。
// 这层的判据不是「有没有输出」，而是**输出里有没有启动链路的证据**。
//
// 判据全部来自真机实测（2026-10-31，ESP32-S3 / /dev/cu.usbmodem1301 经 DTR/RTS 复位）：
//   ESP-ROM:esp32s3-20210327
//   rst:0x15 (USB_UART_CHIP_RESET),boot:0xb (SPI_FAST_FLASH_BOOT)
//   entry 0x403c8908
//   I (35) octal_psram: vendor id    : 0x0d (AP)
//   I (8180) Assets: The checksum calculation time is 94 ms
//
// **一个被真机推翻的预设**（这条比上面那些特征更重要）：
// 原本打算用「非可打印字符比例高 ⇒ 波特率不对」做判据。实测在 USB-CDC 口
// （/dev/cu.usbmodem*，芯片原生 USB）上，**改波特率不影响数据**——用 9600 抓同一个口，
// 拿到的仍是同一条完全干净的日志（非可打印比例 0.000）。因为 CDC 口下波特率是**建议值**，
// 由驱动忽略。所以本模块不产出「garbage/波特率错」这类判决，只把比例当**证据**返回；
// 只有真正的 UART 桥口（ch34x/cp210x/ftdi）才会因速率不匹配产生乱码。
// 给一个查不出来的原因，比说「查不出来」更坏：用户会去重装驱动、换线、改代码。
//
// 另一个刻意的取舍：本模块不猜「板子坏了」。0 字节只说明这段窗口内没有输出，
// 原因可能是日志被关、板子停在下载模式、或固件在静默跑。结论只到「没有启动证据」为止。

// 抓取脚本：**作为单个 argv 元素传给 python，不经过 shell**。
// 所以脚本里出现引号/反引号/`$` 都不是注入面（execFile 不做词法解析）。
// 输出用 base64：execFile 默认按 utf8 解码，二进制字节会被替换成 U+FFFD 而丢失信息，
// 而「是不是真的乱码」恰好需要原始字节。base64 让 JS 侧拿到无损字节，判定逻辑全在 JS 里（可测）。
const CAPTURE_SCRIPT = [
  'import sys, time, base64',
  'try:',
  '    import serial',
  'except Exception:',
  '    print("MJCODE_CAP_NO_PYSERIAL"); raise SystemExit(3)',
  'a = {}',
  'i = 1',
  'while i < len(sys.argv) - 1:',
  '    if sys.argv[i].startswith("--"):',
  '        a[sys.argv[i][2:]] = sys.argv[i + 1]; i += 2',
  '    else:',
  '        i += 1',
  'port = a.get("port", "")',
  'baud = int(a.get("baud", "115200"))',
  'secs = float(a.get("secs", "8"))',
  'try:',
  '    s = serial.Serial(port, baud, timeout=0.2)',
  'except Exception as e:',
  '    print("MJCODE_CAP_OPEN_FAIL %s: %s" % (type(e).__name__, e)); raise SystemExit(4)',
  'try:',
  '    s.dtr = False; s.rts = True; time.sleep(0.12); s.rts = False',
  'except Exception:',
  '    pass',
  'end = time.time() + secs',
  'buf = b""',
  'while time.time() < end:',
  '    buf += s.read(4096)',
  'try:',
  '    s.close()',
  'except Exception:',
  '    pass',
  'sys.stdout.write("MJCODE_CAP_BEGIN\\n")',
  'sys.stdout.write(base64.b64encode(buf).decode("ascii"))',
  'sys.stdout.write("\\nMJCODE_CAP_END %d\\n" % len(buf))',
  'sys.stdout.flush()',
].join('\n');

const CAPTURE_BEGIN = 'MJCODE_CAP_BEGIN';
const CAPTURE_END = 'MJCODE_CAP_END';
const NO_PYSERIAL = 'MJCODE_CAP_NO_PYSERIAL';
const OPEN_FAIL = 'MJCODE_CAP_OPEN_FAIL';

// 启动链路的四类证据。四者互不替代：
//   rom      —— 芯片 ROM 起来了（最早、最硬：能证明「不是死板」）
//   entry    —— 跳到 app 入口（证明 flash 里的镜像被认作可执行镜像）
//   idfLog   —— 应用真的在打日志（最容易满足，也最容易被误当成「跑起来了」）
//   download —— 停在下载模式（这一条要**先判**：下载模式下同样会打 ROM banner，
//               先判 rom 会把「没跑 app」误报成「启动成功」）
const SIGNALS = {
  rom: /ESP-ROM:esp/i,
  entry: /^entry 0x[0-9a-f]+/im,
  idfLog: /^[IWE] \(\d+\) [A-Za-z0-9_.-]+: /m,
  // 只认文本标记，不猜 boot:0x7 这类数值：不同芯片族的下载模式编号不同，
  // 而 "(DOWNLOAD" 是 esptool/ROM 自己打的字，跨型号稳定。
  download: /waiting for download|DOWNLOAD_BOOT|\(DOWNLOAD[^)]*\)/i,
};

const VERDICTS = {
  port: 'port-error',
  noOutput: 'no-output',
  download: 'download-mode',
  booted: 'booted',
  unknown: 'unknown-output',
};

// 复位前的残留：真机实测（2026-10-31）抓到过这种开头——
//   I (5940) wifi:new:<1,1>, ... proESP-ROM:esp32s3-20210327
// 也就是打开端口那一刻，驱动缓冲区里还压着**上一份固件**在跑时的输出，复位只是把新内容接在后面。
// 不切掉它会造出一个最坏的假阳性：expect 里写的 "Ready" 被上一份固件的日志命中，
// 于是结论是「新固件启动正常」——而它可能根本没跑起来。
// 所以判据只用**最后一次启动横幅之后**的部分；横幅之前的内容只算「残留字节数」，如实报出。
const BOOT_ANCHOR = /ESP-ROM:esp/gi;
// 老型号的横幅：ESP32 是 `ets Jun  8 2016 00:22:57`，ESP8266 是 `ets Jan  8 2013,rst cause:2,...`。
// 必须单独成一级：只用 rst:0x 当锚点会把 ets 横幅算成「复位前残留」，
// 于是每次正常启动都多一条假告警 —— 假告警会训练用户忽略真告警。
const BOOT_ANCHOR_ETS = /^ets [A-Z][a-z]{2} +\d+ +\d{4}[ ,]/gim;
// 最次一级：只认 reset 行。此时它前面通常已经没有别的横幅了。
const BOOT_ANCHOR_RST = /rst:0x[0-9a-f]+/gi;

function lastIndexOf(text, re) {
  let idx = -1;
  for (const m of text.matchAll(re)) idx = m.index;
  return idx;
}

function splitStale(text) {
  const s = String(text ?? '');
  // **锚点不能混着取最后一个**：`rst:0x` 就打在 `ESP-ROM:` 之后，混取会把 ROM 横幅切掉，
  // 「有没有 ROM 证据」就被自己判成没有——真机首跑踩到。所以按「横幅强度」分级取：
  // ROM 横幅 → ets 横幅 → 仅 rst 行。
  for (const re of [BOOT_ANCHOR, BOOT_ANCHOR_ETS, BOOT_ANCHOR_RST]) {
    const anchor = lastIndexOf(s, re);
    if (anchor >= 0) return anchor === 0 ? { live: s, staleText: '' } : { live: s.slice(anchor), staleText: s.slice(0, anchor) };
  }
  return { live: s, staleText: '' };
}

/** 非可打印字节占比。只作为证据，不单独构成判决（见文件头对波特率的说明）。 */
function nonPrintableRatio(buf) {
  if (!buf || !buf.length) return 0;
  let bad = 0;
  for (const b of buf) {
    if (b === 9 || b === 10 || b === 13) continue;
    if (b >= 32 && b <= 126) continue;
    if (b >= 128) continue; // UTF-8 中文/符号：不是乱码证据
    bad += 1;
  }
  return bad / buf.length;
}

/**
 * 解析抓取脚本的输出。
 * 长度自检是必须的：base64 段被截断时 `Buffer.from` 不报错，只会安静地少几个字节——
 * 那样「日志里有 panic」可能刚好被切掉，而结论会变成「启动正常」。
 */
function parseCapture(stdout) {
  const text = String(stdout ?? '');
  if (text.includes(NO_PYSERIAL)) {
    return { ok: false, error: '解释器没有 pyserial：抓日志需要 pyserial（pip install pyserial）。'
      + 'macOS 自带的 /usr/bin/python3 通常没有，本机实测只有 anaconda 的解释器有。' };
  }
  const fail = new RegExp(`${OPEN_FAIL}\\s*(.*)`).exec(text);
  if (fail) return { ok: false, portError: true, error: `串口打不开：${String(fail[1] || '').trim()}` };
  const begin = text.indexOf(CAPTURE_BEGIN);
  const end = text.lastIndexOf(CAPTURE_END);
  if (begin < 0 || end < begin) {
    return { ok: false, error: '抓取脚本没有正常结束（没有找到抓取标记）：原始输出见 raw' };
  }
  const b64 = text.slice(begin + CAPTURE_BEGIN.length, end).trim();
  const declared = Number((/\s*(\d+)/.exec(text.slice(end + CAPTURE_END.length)) || [])[1]);
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    // C-001：解码失败不能与「0 字节输出」同形 —— 前者是工具坏了，后者是板子没说话
    return { ok: false, error: '抓取结果 base64 解码失败：本次采集不可用（不是「设备没输出」）' };
  }
  if (Number.isFinite(declared) && declared !== buf.length) {
    return {
      ok: false,
      error: `抓取结果长度不符（声明 ${declared} 字节，解出 ${buf.length} 字节）：采集被截断，结论不可用`,
    };
  }
  return { ok: true, buf, bytes: buf.length };
}

/**
 * 期望特征串：`|`、`,`、换行分隔。
 * 上限不是洁癖：模型可以把整个固件路径甚至一大段文本塞进来，那会让「全部命中」几乎不可能，
 * 结果永远是 mismatch —— 一个永远为假的判据等于没有判据。
 */
function expectTokens(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return [...new Set(s.split(/[|,\n]/).map((t) => t.trim()).filter(Boolean)
    .map((t) => t.slice(0, 80)))]
    .slice(0, 8);
}

/**
 * 从抓到的字节里得出「启动没启动」的结论。
 * @param {Buffer} buf
 * @param {string[]} expect 期望特征串（大小写不敏感子串）
 */
function analyzeLog({ buf = Buffer.alloc(0), expect = [] } = {}) {
  const bytes = buf.length;
  const raw = buf.toString('utf8');
  // 判据只跑「复位之后」的部分（见 BOOT_ANCHOR 注释）：残留输出不参与任何判断
  const { live: text, staleText } = splitStale(raw);
  const signals = {
    rom: SIGNALS.rom.test(text),
    entry: SIGNALS.entry.test(text),
    idfLog: SIGNALS.idfLog.test(text),
    download: SIGNALS.download.test(text),
  };
  const lowered = text.toLowerCase();
  const matched = expect.filter((t) => lowered.includes(t.toLowerCase()));
  const missing = expect.filter((t) => !lowered.includes(t.toLowerCase()));

  let verdict;
  if (signals.download) verdict = VERDICTS.download; // 先判：下载模式下也有 ROM banner
  else if (signals.rom || signals.entry || signals.idfLog) verdict = VERDICTS.booted;
  else if (bytes > 0) verdict = VERDICTS.unknown;
  else verdict = VERDICTS.noOutput;

  return {
    verdict, bytes, text, signals,
    expect: { checked: expect.length, matched, missing },
    staleBytes: Buffer.byteLength(staleText, 'utf8'),
    nonPrintableRatio: Number(nonPrintableRatio(buf).toFixed(3)),
  };
}

/** 预览：头尾各留一段。头有 ROM banner（启动证据），尾有 panic 回溯（失败证据）。 */
function previewOf(text, { head = 1200, tail = 2400 } = {}) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n…（中间略 ${s.length - head - tail} 字）…\n${s.slice(-tail)}`;
}

module.exports = {
  CAPTURE_SCRIPT, CAPTURE_BEGIN, CAPTURE_END, NO_PYSERIAL, OPEN_FAIL, SIGNALS, VERDICTS,
  parseCapture, expectTokens, analyzeLog, nonPrintableRatio, previewOf, splitStale,
};
