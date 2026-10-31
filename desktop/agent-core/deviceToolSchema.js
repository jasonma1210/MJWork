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
      + '另返回 bridges：逐个设备的串口就绪结论（verdict 五档 ready / need-driver / '
      + 'driver-loaded-no-port / not-serial / unknown），portDetails 给出每条串口的 hwid 身份'
      + '（real=false 表示确认不是 USB 串口，如蓝牙虚拟口；real=null 表示查不到）。'
      + '回答「为什么烧不进去」时**先看 bridges[].verdict**：need-driver 是装驱动，'
      + 'driver-loaded-no-port 不是装驱动（设备当前模式没有串口），not-serial（DFU/UF2/调试探针）'
      + '本来就没有串口。'
      + '还返回 channels：每个设备该走哪条刷写通道（esptool-serial / dfu-util / uf2-copy / '
      + 'openocd-swd / stm32flash-serial / avrdude-serial / fastboot）与三件事——'
      + 'confidence（certain=芯片身份确定 / probe-required=桥芯片背后可能是任意 MCU，先跑 chip_id 握手）、'
      + 'implemented（本版本是否已接线该通道的执行器）、runnable（现在能否立即执行）。'
      + '**只有 runnable=true 的通道才能承诺「可以烧」**；implemented=false 表示只识别得出通道、还不能执行。'
      + 'primaryChannel 是首选目标（优先能跑、其次身份确定）。'
      + '用于「板子插上了吗 / 是哪个口 / 该用什么工具 / 为什么烧不进去」这类问题；'
      + '不刷机、不装驱动、不碰 sudo（刷写与装驱动属不可逆动作，另由用户确认）。',
    parameters: { type: 'object', properties: {} },
  }},
];

// device_flash 的芯片名**刻意不加 enum**：未知芯片不是错误，`buildFlashPlan` 会走 esptool 默认值
// 并明确告警。加 enum 会把「新芯片刚上市」变成「模型调不动」，而实际能不能烧由 esptool 决定。
export const DEVICE_FLASH_SCHEMAS = [
  { type: 'function', function: {
    name: 'device_flash',
    description: '把固件烧到开发板。**通道按固件格式自动选**：.bin 走 esptool 串口，.uf2 走 UF2（拷到 bootloader 盘，无需串口），'
      + '.hex/.img 会被拒绝（格式与通道不匹配，见返回的 error 里的转换/替代指引）。五档 action，**烧写必须按序**、不可跳档：'
      + 'list_targets（只读：列可烧磁盘与串口）→ plan（装配命令、给出审批卡与 plan_digest，**不执行**）'
      + '→ flash（**必须**回传 plan_digest，每次都会弹人工审批卡）'
      + '→ verify（回读校验，用同一个 plan_digest；不写设备，把设备内容与本地文件逐字节比对）。'
      + 'backup（整片备份到 out 文件）与上面三档独立，建议在 flash 之前做，否则覆盖后就没有回滚素材了。'
      + 'plan_digest 缺失或不匹配会被拒绝——它锁的是「人确认的参数」与「实际执行的参数」一致。'
      + '只烧固件文件（.bin/.uf2），不做磁盘镜像烧写、不格式化任何存储介质。'
      + 'UF2 通道：plan 阶段自动找 bootloader 盘（判据是盘根有 INFO_UF2.TXT，不是卷名），'
      + '有多个时必须用 volume 显式指定；flash 成功后设备会重启并卸载该卷，卷消失才算完成。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_targets', 'plan', 'flash', 'verify', 'backup'],
          description: 'list_targets=只读列举；plan=装配命令并给出摘要（不执行）；flash=写入（需 plan_digest）；'
            + 'verify=回读校验（需同一个 plan_digest，不写）；backup=整片备份到 out 文件（需 out）。',
        },
        port: {
          type: 'string',
          description: '串口设备路径，必须取自 device_probe 或 list_targets 返回的 ports（如 /dev/cu.wchusbserial110）。'
            + '不要凭记忆猜设备名：flash 时会在实时枚举里核对，不在列表里直接拒绝。',
        },
        firmware: { type: 'string', description: '固件文件路径（绝对路径优先）。不存在或为空文件会被拒绝。与 segments 二选一。' },
        segments: {
          type: 'array',
          description: '多段烧写（ESP-IDF 工程产物通常是 4 段：0x0 bootloader / 0x8000 partition-table / 0x20000 app / 0x800000 assets）。'
            + '与 firmware 二选一；给了 segments 就忽略 firmware/offset。段之间不得重叠，flash 前会实测容量校验不越界。',
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
          description: '芯片族，如 esp32 / esp32s2 / esp32s3 / esp32c3 / esp32c6。缺省 esp32。'
            + '未登记的芯片按 esptool 默认参数执行并给出告警。',
        },
        offset: { type: 'string', description: '烧写偏移，缺省 0x0（整包）。Arduino 导出的 app 固件通常是 0x10000。' },
        plan_digest: { type: 'string', description: 'action=plan 返回的 plan_digest 原文；flash 与 verify 必填，用于防止确认后参数被改。' },
        volume: {
          type: 'string',
          description: 'UF2 通道的目标卷（如 /Volumes/RPI-RP2）。**必须落在系统挂载目录下**（macOS /Volumes、Linux /media 或 /run/media），'
            + '且卷根要有 INFO_UF2.TXT——否则拒绝：这不是"顺便支持一下"，放任任意路径就等于给了一个任意文件写入原语。'
            + '缺省时自动探测；同时插着多个 UF2 盘会拒绝并要求显式指定（挑错就是把 A 的固件写进 B）。',
        },
        out: {
          type: 'string',
          description: 'backup 必填：整片备份的落盘文件路径（绝对路径）。**已存在会被拒绝覆盖**——'
            + '备份通常是唯一的回滚素材，写坏它就等于没有回滚手段。例：/Users/me/backup/board-20261031.bin',
        },
        size: {
          type: 'string',
          description: 'backup 可选：要读取的长度，如 "4MB" / "0x400000"（**裸数字按十进制**）。'
            + '缺省由 flash_id 实测；解析不出会拒绝备份而不是猜一个默认值——读一半的备份比没备份更危险。',
        },
        expect_vid_pid: {
          type: 'string',
          description: '可选的身份钉子，如 "1a86:7523"。给了就必须在本次实时枚举到的 USB 设备里出现，否则拒绝执行。'
            + '串口名（/dev/cu.*）会随插拔和顺序变化、也可能明天指向另一块板子；VID:PID 是硬件身份，'
            + '要确保「烧的就是这块芯片」时应显式给出。',
        },
      },
      required: ['action'],
    },
  }},
];
