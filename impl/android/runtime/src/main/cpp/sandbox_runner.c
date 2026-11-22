/*
 * landlock-run: 自我限制后 exec 的 Landlock 启动器。
 *
 * SPDX-License-Identifier: BSD-3-Clause
 * Copyright (c) 2026 DeepSeek
 *
 * 上游：https://github.com/deepseek-harness/deepseek-harness
 *       native/system/src/main.c（@deepseek-ai/node-addon-system 0.1.2）
 *
 * 用途：作为消费方沙箱缝 `SandboxProvider.confine(argv, policy)` 的一条腿。
 * 在 bwrap 不可用的 Linux 上（未安装 / 非特权 userns 关闭 / LSM 拒绝 mount），
 * Landlock 是一族独立 syscall，不需要上述任何前提。启动器给自身安装 ruleset 后
 * `exec` 被包命令；ruleset 跨 `execve` 继承，因此被包命令及其派生的整棵进程树
 * 都在限制内，而调用方进程不受影响。
 *
 * CLI 契约（已固定，勿改；消费方按此解析）：
 *
 *   landlock-run [--ro <path>]... [--rw <path>]... -- <argv>...
 *   landlock-run --probe
 *   landlock-run --self-test <writable-dir>
 *
 * --ro 授予该路径下读+执行；--rw 授予其下全部文件系统访问；其余一律拒绝
 * （Landlock 是允许列表）。--probe 构造一个最大 ruleset，报告运行内核是否真的
 * 强制执行它 —— 这是执行方的功能性探针。
 *
 * 失败即关闭（fail closed）：ruleset 无法创建、或内核并不强制执行时，启动器
 * 非零退出且**不 exec** 被包命令。较老 ABI 上的部分强制被接受，并在 stderr
 * 报告。启动器自身失败统一 exit 125，stderr 首行以 `landlock-run: ` 开头。
 * 沙箱已生效、但被包命令起不来时 exit 126（见 EXIT_EXEC_FAILURE）——那不是
 * 启动器失败，消费方必须把二者分开，否则用户会去查内核而不是查命令。
 *
 * ---------------------------------------------------------------------------
 * 本文件为 Android 移植：基于上述 main.c，只改了下面五处，其余逻辑（ABI 协商、
 * fs_mask_for_abi、add_rule 的目录/文件位裁剪、PR_SET_NO_NEW_PRIVS 顺序）逐行
 * 保留。
 *
 *   1) 失败行追加 errno。原文案与 `landlock-run: ` 前缀全部保留（消费方做子串
 *      匹配），只在行尾追加 `[errno=N]`。原因：Android 的 app seccomp 白名单
 *      是否放行 landlock 三个 syscall 在真机上未知，而 0/38/95 是唯一能区分
 *      「可用」「内核没有或被 seccomp 拦成 ENOSYS」「有 syscall 但 LSM 未启用」
 *      的证据 —— 丢掉 errno 就等于丢掉唯一证据。
 *   2) --probe 增加机器可读输出。成功/失败都在 stdout 打**一行** JSON，人类可读
 *      那行改到 stderr，避免污染解析。失败仍 exit 125、仍打 stderr 人类行。
 *   3) 新增 --self-test <writable-dir>：装只读规则集（--ro /）后尝试在给定目录
 *      建文件，预期 EACCES。它验证的是「规则真的挡住了写」，比 --probe 更强。
 *   4) execvp 失败改用 exit 126 与独立文案（fail_exec）。上游把它并进 125 的
 *      `landlock-run: exec failed`，消费方会判成 runner 挂了。沙箱明明已生效，
 *      失败只是「命令不存在 / 不可执行」（Android 上常常是没有 bash）。
 *   5) 头注释改写成本段（BSD-3 保留、上游地址保留、移植说明）。
 *
 * 二进制名固定为 `libdsh-sandbox-runner.so`：Android 只允许从
 * nativeLibraryDir 执行 `lib*.so` 命名的 ELF（实际是 PIE 可执行文件，靠
 * `-fPIE -pie` 拿到 PT_INTERP 与入口点，而非真的当共享库加载）。
 *
 * 仅依赖 libc（Android 上就是 bionic）；Landlock UAPI 自行声明，不 include
 * <linux/landlock.h>，以免绑定工具链头文件版本。
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/*
 * Landlock UAPI 就地声明而不 include <linux/landlock.h>：内核的用户态 ABI 由
 * 契约保证稳定，自行定义让构建不依赖工具链头文件的新旧；这份定义同时充当
 * 「本启动器到底碰了哪些内核 API」的审计记录。布局与取值逐字来自内核头文件
 * （path_beneath 结构在内核里就是 packed 的，这里必须同样 packed）。
 */
struct landlock_ruleset_attr {
  uint64_t handled_access_fs;
};

struct landlock_path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

/* 文件系统访问位，按引入它们的 Landlock ABI 分组。 */
#define LL_FS_EXECUTE     (UINT64_C(1) << 0)  /* ABI 1 */
#define LL_FS_WRITE_FILE  (UINT64_C(1) << 1)
#define LL_FS_READ_FILE   (UINT64_C(1) << 2)
#define LL_FS_READ_DIR    (UINT64_C(1) << 3)
#define LL_FS_REMOVE_DIR  (UINT64_C(1) << 4)
#define LL_FS_REMOVE_FILE (UINT64_C(1) << 5)
#define LL_FS_MAKE_CHAR   (UINT64_C(1) << 6)
#define LL_FS_MAKE_DIR    (UINT64_C(1) << 7)
#define LL_FS_MAKE_REG    (UINT64_C(1) << 8)
#define LL_FS_MAKE_SOCK   (UINT64_C(1) << 9)
#define LL_FS_MAKE_FIFO   (UINT64_C(1) << 10)
#define LL_FS_MAKE_BLOCK  (UINT64_C(1) << 11)
#define LL_FS_MAKE_SYM    (UINT64_C(1) << 12)
#define LL_FS_REFER       (UINT64_C(1) << 13) /* ABI 2 */
#define LL_FS_TRUNCATE    (UINT64_C(1) << 14) /* ABI 3（ABI 4 只加了 TCP 位） */
#define LL_FS_IOCTL_DEV   (UINT64_C(1) << 15) /* ABI 5 */

#define LL_ABI1_MASK (LL_FS_REFER - 1) /* 位 0..12：ABI-1 的全部访问，不含更新的 */

/*
 * 本构建认识的最新 ABI；下面的协商会把实际 ruleset 缩到运行内核支持的范围。
 */
#define MAX_ABI 5L

/*
 * Landlock 没有 libc 包装；这些是裸 syscall。编号在所有架构上相同（2011 年后的
 * 统一表），fallback 只对缺特性的老 libc 有意义。
 */
#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

/*
 * 每条致命错误都向 stderr 打 `landlock-run: <message>` 并 exit 125 —— 这个码
 * 被包命令自己几乎不会用，执行方据此把启动器失败与命令失败区分开。
 */
#define EXIT_LAUNCHER_FAILURE 125
/*
 * 沙箱已生效、只是被包命令起不来：126。必须与 125 区分 —— 125 表示启动器
 * （landlock 链）失败，消费方据此报 SANDBOX_UNAVAILABLE，用户会去查内核 / ROM；
 * 而 126 的真实原因通常是「Android 上没有 bash」或「命令没有可执行位」，方向
 * 完全相反。126 也是 shell 的 "command found but not executable" 惯例。
 */
#define EXIT_EXEC_FAILURE 126

static const char NOT_ENFORCED_MESSAGE[] =
  "landlock is not enforced by this kernel (ABI unsupported or disabled)";

/*
 * 失败诊断。restrict_self() 只返回退出码，而 --probe 的 JSON 需要知道「卡在
 * 哪一步、errno 是多少」，所以把这两项记在文件级变量里，main 在失败分支读取。
 * g_abi 在 create_ruleset(VERSION) 成功后填充，失败时保持 -1。
 */
static long g_abi = -1;
static int g_errno;
static const char *g_stage = "create";

/* 打一行致命 `landlock-run: ...`；返回致命退出码。 */
static int fail(const char *prefix, const char *detail) {
  if (detail == NULL) {
    fprintf(stderr, "landlock-run: %s\n", prefix);
  } else {
    fprintf(stderr, "landlock-run: %s: %s\n", prefix, detail);
  }
  return EXIT_LAUNCHER_FAILURE;
}

/*
 * Landlock 相关失败的统一出口：原有文案与 `landlock-run: ` 前缀一字不动，
 * 只把 errno 追加在行尾方括号里（消费方按子串匹配，只能追加不能改写）。
 * err 必须由调用方在触碰 stdio 之前保存好 —— fprintf 会覆盖 errno。
 */
static int fail_landlock(const char *prefix, const char *detail, int err, const char *stage) {
  g_errno = err;
  g_stage = stage;
  if (detail == NULL) {
    fprintf(stderr, "landlock-run: %s [errno=%d]\n", prefix, err);
  } else {
    fprintf(stderr, "landlock-run: %s: %s [errno=%d]\n", prefix, detail, err);
  }
  return EXIT_LAUNCHER_FAILURE;
}

static int fail_usage(const char *message, const char *detail) {
  fprintf(stderr, "landlock-run: usage error: %s%s\n", message, detail == NULL ? "" : detail);
  return EXIT_LAUNCHER_FAILURE;
}

/*
 * 被包命令 exec 失败。detail 里禁止出现 "Permission denied"：消费方的
 * denialSignatures 含 "permission denied"，一旦命中，模型会把「命令本身不可
 * 执行」当成「沙箱拒绝写入」并去申请 escalation。所以 EACCES 改写成
 * "not executable (EACCES)"；其余 errno 用 strerror（ENOENT 是
 * "No such file or directory"，不含该子串）。err 由调用方在 execvp 之后
 * 立刻保存 —— 任何 stdio 调用都可能覆盖 errno。
 */
static int fail_exec(const char *prog, int err) {
  const char *detail = (err == EACCES) ? "not executable (EACCES)" : strerror(err);
  fprintf(stderr, "landlock-run: cannot exec `%s`: %s [errno=%d]\n", prog, detail, err);
  return EXIT_EXEC_FAILURE;
}

/* 解析后的 CLI：要么是探针/自检，要么是若干授权加 `--` 之后的命令 argv。 */
struct cli {
  int probe;
  const char *self_test_dir; /* --self-test 给的目录；NULL 表示没启用 */
  const char **ro;
  size_t ro_count;
  const char **rw;
  size_t rw_count;
  char **command; /* main 的 argv 尾部，NULL 结尾 */
};

/*
 * 手写 argv 解析 —— 几个 flag 不值得引入解析库。
 * 成功返回 0，否则返回进程退出码（消息已打印）。
 */
static int parse(int argc, char **argv, struct cli *cli) {
  /* argc 是每个授权列表的上界；启动器不是 exec 就是退出，所以不 free。 */
  cli->ro = calloc(argc > 0 ? (size_t)argc : 1, sizeof *cli->ro);
  cli->rw = calloc(argc > 0 ? (size_t)argc : 1, sizeof *cli->rw);
  if (cli->ro == NULL || cli->rw == NULL) return fail("out of memory", NULL);

  int index = 1;
  while (index < argc) {
    const char *arg = argv[index];
    if (strcmp(arg, "--probe") == 0) {
      if (argc != 2) {
        return fail_usage("--probe takes no other arguments", NULL);
      }
      cli->probe = 1;
      index += 1;
    } else if (strcmp(arg, "--self-test") == 0) {
      /* 自检要一个「本来可写」的目录：否则 EACCES 可能只是普通权限位，
       * 证明不了是 landlock 挡的。 */
      if (index + 1 >= argc) {
        return fail_usage(arg, " requires a writable directory");
      }
      if (argc != 3) {
        return fail_usage("--self-test takes exactly one directory", NULL);
      }
      cli->self_test_dir = argv[index + 1];
      index += 2;
    } else if (strcmp(arg, "--ro") == 0 || strcmp(arg, "--rw") == 0) {
      if (index + 1 >= argc) {
        return fail_usage(arg, " requires a path");
      }
      if (strcmp(arg, "--ro") == 0) {
        cli->ro[cli->ro_count++] = argv[index + 1];
      } else {
        cli->rw[cli->rw_count++] = argv[index + 1];
      }
      index += 2;
    } else if (strcmp(arg, "--") == 0) {
      cli->command = &argv[index + 1];
      break;
    } else {
      return fail_usage("unknown argument: ", arg);
    }
  }
  if (!cli->probe && cli->self_test_dir == NULL &&
      (cli->command == NULL || cli->command[0] == NULL)) {
    return fail_usage("missing `-- <argv>...` command", NULL);
  }
  return 0;
}

/* 运行内核的 ABI 能管辖的文件系统访问。 */
static uint64_t fs_mask_for_abi(long abi) {
  uint64_t mask = LL_ABI1_MASK;
  if (abi >= 2) mask |= LL_FS_REFER;
  if (abi >= 3) mask |= LL_FS_TRUNCATE;
  if (abi >= 5) mask |= LL_FS_IOCTL_DEV;
  return mask;
}

/* 加一条 path-beneath 规则；成功 0，否则返回退出码。 */
static int add_rule(int ruleset_fd, const char *path, uint64_t access) {
  int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0) {
    /* 授权根打不开就失败关闭：悄悄收窄授权集合虽然安全，但让调用方拿到一份
     * 它没要求的 profile，不值得那点含糊。 */
    int saved = errno;
    char prefix[1024];
    snprintf(prefix, sizeof prefix, "cannot open rule path: %s", path);
    return fail_landlock(prefix, strerror(saved), saved, "add_rule");
  }
  /* 内核对非目录规则上的「目录专属访问位」返回 EINVAL，所以文件授权只留
   * 文件兼容位 —— `--rw /dev/null` 就是这么工作的。 */
  struct stat st;
  if (fstat(path_fd, &st) == 0 && !S_ISDIR(st.st_mode)) {
    access &= LL_FS_EXECUTE | LL_FS_WRITE_FILE | LL_FS_READ_FILE | LL_FS_TRUNCATE | LL_FS_IOCTL_DEV;
  }
  struct landlock_path_beneath_attr attr = { .allowed_access = access, .parent_fd = path_fd };
  if (syscall(__NR_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0) {
    int saved = errno;
    close(path_fd);
    return fail_landlock("landlock ruleset error", strerror(saved), saved, "add_rule");
  }
  close(path_fd);
  return 0;
}

/*
 * 在当前线程上安装 ruleset，并把内核 ABI 从 MAX_ABI 往下协商。`--ro` 路径拿
 * 读侧词汇（读文件/目录 + 执行 —— 被包的 `bash` 及其派生进程必须仍可执行）；
 * `--rw` 路径拿协商后 ABI 能授予的全部访问。先设 no_new_privs（非特权 restrict
 * 的必要条件，同时让沙箱内的 setuid/setgid 提权失效）。成功时 `*partial` 报告
 * 内核是否只管辖了 MAX_ABI 访问的一个子集。返回 0，否则返回退出码。
 */
static int restrict_self(const struct cli *cli, int *partial) {
  long abi = syscall(__NR_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    /* ENOSYS(38)：内核没编进 Landlock，或被 app seccomp 拦成 ENOSYS；
     * EOPNOTSUPP(95)：有 syscall 但 LSM 未启用。两种都不可强制：失败关闭，
     * 绝不无限制地 exec。errno 是区分这两者的唯一证据，必须带出去。 */
    int saved = errno;
    return fail_landlock(NOT_ENFORCED_MESSAGE, NULL, saved, "create");
  }
  g_abi = abi;
  *partial = abi < MAX_ABI;
  uint64_t handled = fs_mask_for_abi(abi < MAX_ABI ? abi : MAX_ABI);

  struct landlock_ruleset_attr attr = { .handled_access_fs = handled };
  int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, &attr, sizeof attr, 0);
  if (ruleset_fd < 0) {
    int saved = errno;
    return fail_landlock("landlock ruleset error", strerror(saved), saved, "create");
  }

  const uint64_t read_side = LL_FS_EXECUTE | LL_FS_READ_FILE | LL_FS_READ_DIR;
  for (size_t i = 0; i < cli->ro_count; i++) {
    int code = add_rule(ruleset_fd, cli->ro[i], read_side & handled);
    if (code != 0) return code;
  }
  for (size_t i = 0; i < cli->rw_count; i++) {
    int code = add_rule(ruleset_fd, cli->rw[i], handled);
    if (code != 0) return code;
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    int saved = errno;
    return fail_landlock("landlock ruleset error", strerror(saved), saved, "no_new_privs");
  }
  if (syscall(__NR_landlock_restrict_self, ruleset_fd, 0) != 0) {
    int saved = errno;
    return fail_landlock("landlock ruleset error", strerror(saved), saved, "restrict_self");
  }
  close(ruleset_fd);
  g_errno = 0;
  return 0;
}

/*
 * --probe 的机器可读输出：stdout 恰好一行 JSON，flush 后调用方才允许退出。
 * 人类可读的判决行在 stderr，解析方读 stdout 不会被打扰。
 */
static void probe_json(int ok, int partial) {
  if (ok) {
    printf("{\"ok\":true,\"abi\":%ld,\"partial\":%s,\"errno\":0}\n",
           g_abi, partial ? "true" : "false");
  } else {
    printf("{\"ok\":false,\"errno\":%d,\"stage\":\"%s\",\"abi\":%ld}\n",
           g_errno, g_stage, g_abi);
  }
  fflush(stdout);
}

/*
 * --self-test <writable-dir>：装上只读规则集（--ro /）后尝试在目录里建文件。
 * 成功建出来 = 规则没挡住写，说明内核没真正强制 -> 失败关闭；EACCES = 拒绝
 * 生效 -> _exit(0)。比 --probe 强的地方在于它验的是「写真的被挡住」。
 */
static int self_test(const char *dir) {
  if (dir == NULL || access(dir, W_OK) != 0) {
    /* 目录本来就不可写的话，EACCES 无法归因于 landlock，自检没有意义。 */
    return fail_usage("--self-test needs an existing writable directory: ", dir);
  }

  static const char *probe_root = "/";
  struct cli ro = { .ro = &probe_root, .ro_count = 1 };
  int partial = 0;
  int code = restrict_self(&ro, &partial);
  if (code != 0) return code; /* 失败行（含 errno）已经打过 */

  size_t len = strlen(dir) + sizeof "/..probe";
  char *path = malloc(len);
  if (path == NULL) return fail("out of memory", NULL);
  snprintf(path, len, "%s/..probe", dir);

  int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (fd >= 0) {
    close(fd);
    unlink(path);
    return fail("self-test failed: write was NOT denied", path);
  }
  int saved = errno;
  if (saved != EACCES && saved != EPERM) {
    return fail_landlock("self-test inconclusive", strerror(saved), saved, "restrict_self");
  }
  /* 拒绝生效。用 _exit 而非 exit：不跑 atexit/stdio 冲刷，保持自检极简。 */
  _exit(0);
}

int main(int argc, char **argv) {
  struct cli cli = { 0 };
  int code = parse(argc, argv, &cli);
  if (code != 0) return code;

  if (cli.probe) {
    /* 功能性探针：在本进程（探针跑完即退出）里构造并强制一个最大 ruleset。
     * 仅查 `--version` 会漏掉「有 syscall 但拒绝强制」的内核；真的 restrict
     * 一次才是唯一诚实的信号。判决行是启动器 CLI 契约的一部分 —— 执行方从
     * 它读强制的完整度。这里改走 stderr：stdout 留给 JSON。 */
    static const char *probe_root = "/";
    struct cli probe = { .ro = &probe_root, .ro_count = 1 };
    int partial = 0;
    code = restrict_self(&probe, &partial);
    if (code != 0) {
      probe_json(0, 0);
      return code;
    }
    fprintf(stderr, "landlock: %s\n", partial ? "partially enforced (older ABI)" : "fully enforced");
    probe_json(1, partial);
    return 0;
  }

  if (cli.self_test_dir != NULL) return self_test(cli.self_test_dir);

  int partial = 0;
  code = restrict_self(&cli, &partial);
  if (code != 0) return code;
  if (partial) {
    /* 较老 ABI：部分 handled 访问不被管辖（例如 ABI 3 之前的 truncate）。
     * 内核支持的部分仍然受困 —— 报告，不拒绝。 */
    fprintf(stderr, "landlock-run: partial enforcement (older Landlock ABI)\n");
  }

  execvp(cli.command[0], cli.command);
  /* exec 只在失败时返回。沙箱已经装好了，所以这是「命令起不来」，不是
   * 「启动器失败」—— 走 126 的专用出口。 */
  int saved = errno;
  return fail_exec(cli.command[0], saved);
}
