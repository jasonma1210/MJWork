// main/tools/shellEnv.js
// 子 shell 环境构造：完整 PATH 注入（沙箱内外一致）。
//
// 抽成独立模块的原因（2026-10-16）：原逻辑内联在 tools/exec.js 里，使该文件
// 触及 800 行 max-lines 上限。该门禁正是为防"上帝文件"而设，继续往里塞就是对抗它。
// 独立成模块同时为后续 main/cmd/ 命令抽象层预留了接缝（平台相关逻辑应集中于此）。
//
// P0 修复（2026-10-16）——原实现是单一 POSIX 常量 + ':' 拼接：
//   · 分隔符在 Windows 上是 ';'，用 ':' 会把整串当**单个**非法目录条目
//     ⇒ node / npm / git / python 全部 ENOENT（确定性失败，非概率性）；
//   · 常量本体是 POSIX 路径（/usr/bin 等），在 Windows 上根本不存在；
//   · 取 HOME 取不到（Windows 用 USERPROFILE）⇒ 用户级工具目录全丢。

const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';

// POSIX 工具目录（homebrew 优先，其次系统路径）
const POSIX_TOOL_DIRS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/usr/local/bin', '/usr/local/sbin',
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
];
// Windows 工具目录（与 POSIX 侧那组等价）
const WIN_TOOL_DIRS = [
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
];

// 保留导出形态（字符串）供既有消费者引用；内容为按平台解析后的系统工具目录
const SHELL_PATH = (IS_WIN ? WIN_TOOL_DIRS : POSIX_TOOL_DIRS).join(PATH_SEP);

// N2 env 允许表（2026-10-16，方案 §8.1「env 允许表 + 每工具 secret 注入」）：
// 此前 shellEnv 返回 { ...process.env, PATH }——Agent 子命令继承宿主**全部**环境变量，
// 用户 shell 里可能存在的 API Key / token / 内网地址会直接泄漏给模型可读的命令输出
//（env / printenv 即可枚举），且威胁模型上是把宿主凭证交给了被治理的执行面。
// 现按白名单收敛：只透传运行所需的基础变量；缺失导致工具异常的条目按可行动反馈补充白名单，
// **禁止**为图省事回退全量继承。
const ENV_ALLOWLIST = [
  // 身份与运行基础
  'HOME', 'USERPROFILE', 'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION',
  'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  // 临时目录与 XDG
  'TMPDIR', 'TEMP', 'TMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // Windows 系统变量
  'SystemRoot', 'SystemDrive', 'WINDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'CommonProgramFiles', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT',
  'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  // 开发工具链显式配置（按需维护，不整段继承）
  'SSH_AUTH_SOCK', 'GPG_TTY',
  'NVM_DIR', 'VOLTA_HOME', 'PYENV_ROOT', 'RBENV_ROOT', 'CARGO_HOME', 'RUSTUP_HOME',
  'GOPATH', 'GOROOT', 'JAVA_HOME', 'GRADLE_HOME', 'MAVEN_HOME',
  'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'SDKROOT', 'DEVELOPER_DIR',
  'CONDA_PREFIX', 'VIRTUAL_ENV', 'BUNDLE_GEMFILE', 'GEM_HOME',
  'OPENSSL_CONF', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'GIT_SSL_CAINFO',
  // Node 生态
  'NODE_OPTIONS', 'NODE_PATH', 'npm_config_registry', 'NPM_CONFIG_REGISTRY', 'COREPACK_ENABLE_DOWNLOAD_PROMPT',
  // 网络（企业代理环境必需；大小写两种形态都保留）
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

// 探测抛错过的路径（去重，避免每次执行都刷一行）
const probeFailed = new Set();

function shellEnv() {
  const home = IS_WIN ? (process.env.USERPROFILE || '') : (process.env.HOME || '');
  // 打包版冒烟实测（2026-10-15）：MCP 重连 spawn uvx ENOENT——uv 官方装到
  // ~/.local/bin（pipx 风格），uv 亦可能装到 ~/.cargo/bin；此前缺这两个目录，
  // 打包版里 uvx 类 MCP Server 全部启动失败（开发版因继承终端 PATH 而复现不了）。
  const userPaths = home
    ? [
      path.join(home, '.bun', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.local', 'bin'),
      path.join(home, '.cargo', 'bin'),
    ]
    : [];
  const all = [...userPaths, ...(IS_WIN ? WIN_TOOL_DIRS : POSIX_TOOL_DIRS)];
  // 只保留真实存在的目录：注入不存在的路径既无意义，也让 PATH 解析变慢
  // 探测抛错时按「不存在」丢弃，但这个丢弃会让该目录里的工具全部 ENOENT（表现成「没装」），
  // 与「确实没装」不可区分 ⇒ 每个路径只 warning 一次（shellEnv 每次执行都会被调用，不去重会刷屏）。
  const existing = all.filter((p) => {
    try { return fs.existsSync(p); } catch (e) {
      if (!probeFailed.has(p)) { probeFailed.add(p); console.warn('[shellEnv] 路径探测失败，已从子进程 PATH 剔除（该目录内的工具将 ENOENT）：', p, e?.message || e); }
      return false;
    }
  });
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PATH = existing.join(PATH_SEP);
  return env;
}

module.exports = { shellEnv, SHELL_PATH, IS_WIN, PATH_SEP, POSIX_TOOL_DIRS, WIN_TOOL_DIRS };