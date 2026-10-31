// device_* 工具 schema（2026-10-31）：单独成模块的理由是**行数棘轮**，不是职责边界。
//
// test/max-lines.test.js 把 agent-core/index.js 的快照钉死在实测 code 行数上（只减不增），
// 内联一个 ~12 行的 schema 会直接让该门禁变红。而 schema 是纯数据（无依赖、无求值顺序），
// 外置成模块后 index.js 只需一行 import + 一行展开，正好用「纯数据外置」换回行数余量。
//
// 维护规则：新增 device_* 工具时**只往本数组追加**，不要在 index.js 里内联 schema；
// 同时按 tool-registration-matrix 的 7 环节逐项接线（本文件只承担第 ① 环节）。
//
// device_probe 不设参数：探测目标由**宿主平台**决定（process.platform），
// 不接受模型传 platform —— 否则「探测哪个平台」变成模型可控输入，白白多一条治理面。
export const DEVICE_TOOL_SCHEMAS = [
  { type: 'function', function: {
    name: 'device_probe',
    description: '探测本机接了什么 USB 设备与串口（只读）。'
      + '返回 devices（VID/PID 解析出的芯片型号与所需驱动）、ports（可用串口）、'
      + 'flashable（可烧写候选）、toolchain.esptool（工具链是否就绪）与 notes（探测失败/降级原因）。'
      + '另返回 bridges（verdict 五档 ready / need-driver / driver-loaded-no-port / not-serial / unknown）'
      + '与 portDetails（每条串口的 hwid 身份；real=false=确认非 USB 串口如蓝牙虚拟口，real=null=查不到）。'
      + '回答「为什么烧不进去」**先看 bridges[].verdict**：need-driver 是装驱动；driver-loaded-no-port 不是'
      + '（设备当前模式没串口）；not-serial（DFU/UF2/调试探针）本来就没串口。'
      + '还返回 channels：每个设备该走哪条刷写通道（esptool-serial / dfu-util / uf2-copy / '
      + 'openocd-swd / stm32flash-serial / avrdude-serial / fastboot）与三件事：'
      + 'confidence（certain=芯片身份确定 / probe-required=桥芯片背后可能是任意 MCU，'
      + '须先用 device_flash action=chip_id 握手问清，**不要**让用户自己去命令行跑）、'
      + 'implemented（本版本是否已接线执行器）、runnable（现在能否立即执行）。'
      + '**只有 runnable=true 才能承诺「可以烧」**；implemented=false = 只识别得出通道、还不能执行。'
      + 'primaryChannel 是首选目标（优先能跑、其次身份确定）。'
      + '不刷机、不装驱动、不碰 sudo（刷写与装驱动属不可逆动作，另由用户确认）。',
    parameters: { type: 'object', properties: {} },
  }},
];

// device_flash 的芯片名**刻意不加 enum**：未知芯片不是错误，`buildFlashPlan` 会走 esptool 默认值
// 并明确告警。加 enum 会把「新芯片刚上市」变成「模型调不动」，而实际能不能烧由 esptool 决定。
//
// ⚠ 预算压力（2026-10-31 实测）：`test/context-budget.test.mjs` 要求
// `MAX_TOOL_SCHEMA_TOTAL_BYTES > toolTableByteSize(BASE_TOOLS) * 1.5`，而本文件加完
// fastboot 的 channel/partition/serial/slot 四个属性后，整表 43679 / 阈值线 43690 —— **余量只剩 11 字节**。
// 也就是说：这里再加一个字段（或把描述写长两行）就会让那条闸变红，而它不是坏闸，
// 是「静态工具表已经吃满 64KB 预算」的信号。真要加字段，先想清楚三件事：
//   ① 能不能把信息压进已有属性（例如用 enum 而不是新段落）；② 能不能删掉别处的重复描述；
//   ③ 只有当前两条都不成立时，才去动 `MAX_TOOL_SCHEMA_TOTAL_BYTES` 并同时改它的钉值测试与设计文档。
export const DEVICE_FLASH_SCHEMAS = [
  { type: 'function', function: {
    name: 'device_flash',
    description: '把固件烧到开发板/手机。**通道按格式自动选**：.bin→esptool 串口（DFU 板须显式 channel=dfu），'
      + '.uf2→UF2（拷到 bootloader 盘，无需串口），.dfu→dfu-util，.img 须显式 channel=fastboot+partition；'
      + '.hex 拒绝并给转换指引。不做磁盘镜像、不格式化介质。'
      + '烧写按序不可跳档：plan → flash（需 plan_digest）→ verify，digest 锁「人确认过的参数」，缺失或不符即拒。'
      + 'backup 应放在 flash **之前**，否则覆盖后没有回滚素材。'
      + 'chip_id 用于 device_probe 报 probe-required 时由工具自己问身份，别让用户手敲命令。'
      + 'logs 抓串口启动输出，判据是启动证据而非「有输出」：verify 证明字节写对，logs 才证明固件在跑。'
      + 'UF2：plan 自动找盘（判据是盘根 INFO_UF2.TXT 而非卷名），多盘必须用 volume 指定；设备重启卸载该卷才算完成。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_targets', 'chip_id', 'plan', 'flash', 'verify', 'backup', 'logs'],
          description: '**烧写必须按序、不可跳档**：list_targets（只读列举）→ chip_id（握手确认身份，需 port）'
            + '→ plan（装配命令+摘要，不执行）→ flash（写入，需 plan_digest）→ verify（回读校验，同一 digest，不写）。'
            + 'backup=整片备份（需 out）；logs=抓启动日志（需 port）。',
        },
        port: {
          type: 'string',
          description: '串口路径，必须取自 device_probe 或 list_targets 的 ports；不要凭记忆猜，flash 时会在实时枚举里核对。',
        },
        firmware: { type: 'string', description: '固件路径。不存在或空文件会被拒绝。与 segments 二选一。' },
        segments: {
          type: 'array',
          description: '多段烧写（ESP-IDF 产物通常 4 段：0x0 / 0x8000 / 0x20000 / 0x800000）。与 firmware 二选一；'
            + '段不得重叠，flash 前实测容量校验不越界。',
          items: {
            type: 'object',
            properties: {
              offset: { type: 'string', description: '该段写入偏移，0x 开头十六进制，如 0x10000' },
              file: { type: 'string', description: '该段固件文件路径' },
            },
            required: ['offset', 'file'],
          },
        },
        chip: {
          type: 'string',
          description: '芯片族：esp32 / esp32s2 / esp32s3 / esp32c3 / esp32c6，缺省 esp32；未登记型号按默认参数并告警。',
        },
        offset: { type: 'string', description: '烧写偏移，缺省 0x0。Arduino 导出的 app 固件通常是 0x10000。' },
        plan_digest: { type: 'string', description: 'plan 返回的 plan_digest 原文；flash/verify 必填，防确认后参数被改。' },
        volume: {
          type: 'string',
          description: 'UF2 目标卷。必须在系统挂载目录下（/Volumes、/media、/run/media）且卷根有 INFO_UF2.TXT，'
            + '否则拒绝；缺省自动探测，多盘必须显式指定。',
        },
        out: {
          type: 'string',
          description: 'backup 必填：落盘绝对路径。**已存在会拒绝覆盖**——它通常是唯一的回滚素材。',
        },
        size: {
          type: 'string',
          description: 'backup 可选：读取长度，如 "4MB" / "0x400000"（裸数字按十进制）。缺省由 flash_id 实测，解析不出就拒绝。',
        },
        expect_vid_pid: {
          type: 'string',
          description: '可选身份钉子，如 "1a86:7523"。给了就必须在实时枚举里出现，否则拒绝。',
        },
        channel: {
          type: 'string',
          enum: ['esptool', 'dfu', 'fastboot'],
          description: '写入通道。`.bin` 是 esptool 与 DFU 共用的裸二进制：DFU 设备（0483:df11、无串口）'
            + '必须传 dfu 并给 offset（STM32 主 flash 通常 0x08000000）。`.uf2`/`.dfu` 按扩展名分流。'
            + '`.img` 必须显式 fastboot（同一扩展名也可能是 SD 卡整盘镜像）。',
        },
        partition: {
          type: 'string',
          description: 'fastboot 必填：刷哪个分区（boot / recovery / system）。'
            + 'A/B 设备只写 boot 会落到当前槽，指定槽写 boot_b。bootloader / xbl / modem 等引导链分区硬拒。',
        },
        serial: {
          type: 'string',
          description: 'fastboot 可选：序列号，多台在线时必须指定。取自 device_probe 或 fastboot devices。',
        },
        slot: {
          type: 'string',
          enum: ['a', 'b'],
          description: 'fastboot 可选：A/B 槽位，缺省用当前槽；与当前槽不同会告警。',
        },
        seconds: { type: 'integer', description: 'logs 可选：抓多少秒，缺省 8，夹在 2–30。' },
        expect: {
          type: 'string',
          description: 'logs 可选：期望特征串，`|` 或逗号分隔（≤8 条，大小写不敏感）。给了就要求全部命中——'
            + '这是「跑的是不是我要的固件」。',
        },
        baud: { type: 'integer', description: 'logs 可选：抓取波特率，缺省 115200。原生 USB 口该值仅是建议值。' },
      },
      required: ['action'],
    },
  }},
];
