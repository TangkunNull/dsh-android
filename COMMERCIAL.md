# 商业授权 / Commercial Licensing

本项目以 **AGPL-3.0** 发布（见 [LICENSE](LICENSE)）。AGPL 是 OSI 认可的开源许可证：**任何人都可以商用，代价是必须开源**。如果商业使用需要闭源，就必须另外取得作者的商业授权。

This project is licensed under **AGPL-3.0**. Commercial use is permitted, but AGPL requires you to release your complete corresponding source, including when the software is offered as a network service. If you need to keep your modifications proprietary, a separate commercial license is required.

---

## 一、不用问、也不用付钱的场景

| 场景 | 义务 |
|---|---|
| 自己装来用 | 无 |
| 学习、研究、教学、安全分析 | 无 |
| 修改后自己留着用 | 无 |
| 在博客 / 视频 / 论文里演示、截图、引用 | 无 |
| 非商业项目、公益项目 | 无 |

## 二、可以商用，但要开源

AGPL 不禁止赚钱。以下场景**合法**，前提是履行 AGPL 的义务：

| 场景 | 你要做的 |
|---|---|
| 把改过的版本发给别人 / 卖给别人 | 提供完整可构建的源码，且以 AGPL-3.0 授权 |
| 基于它做付费产品、随硬件分发 | 同上，源码要跟着走 |
| 部署成网络服务（SaaS、云手机、远程桌面）让用户通过网络使用 | 向使用者提供完整源码的获取方式（AGPL 第 13 条） |
| 公司内部部署 | 内部使用不构成"分发"，通常无义务；一旦对外提供，义务立刻成立 |

「提供源码」不是给个 GitHub 链接就算：必须是**对应版本**、**可构建**、**包含你的修改**。用 AGPL 代码做出闭源产品再卖，是被明确禁止的。

## 三、需要买授权的场景

只有一种：**你要闭源商用**。具体包括：

- 把本项目或其衍生作品集成进闭源产品对外销售；
- 改名换皮后分发，且不愿公开源码；
- 以它为基础提供商业服务，但不愿向用户提供源码；
- 企业内部二次开发后不愿按 AGPL 公开衍生代码。

## 四、怎么申请

在仓库提一个 Issue，标题以 `[Commercial]` 开头，或在 GitHub 上直接联系 [@TangkunNull](https://github.com/TangkunNull)。请一并说明：

1. 使用主体（个人 / 公司名称、所在地区）；
2. 使用方式（内部部署 / 随产品分发 / SaaS / 其它）；
3. 分发规模（装机量、租户数、客户数量级）；
4. 需要闭源的具体范围（整个产品，还是只有某个模块）。

授权按用途与规模单独报价，可开正规发票。**未拿到书面授权前，请勿开始闭源商用** —— 口头沟通不构成授权。

## 五、授权不覆盖的部分

商业授权只覆盖本项目作者拥有的著作权。仓库内及 APK 内的第三方组件仍受它们各自的许可证约束：

- Node.js 运行时（`libnode.so`）—— MIT
- Flutter 引擎与框架 —— BSD-3-Clause
- `impl/fixtures/` 下的社区插件 —— 版权归各自作者，本项目不为其授权
- 打包进 APK 的上游运行时包 —— 见各包 `package.json`

详见 [NOTICE.md](NOTICE.md)。

## 六、贡献者的再许可授权

双轨授权有一个前提：**作者必须对全部代码拥有著作权**。如果仓库里混进了别人提交的代码，而那人只按 AGPL 授权，作者就无权对那部分发商业授权。所以：

提交 Pull Request、补丁或任何形式的代码贡献，即表示你同意两件事：

1. 你的贡献以 **AGPL-3.0** 授权给本项目及所有使用者；
2. 你**另行授权本项目作者**（TangkunNull）对你的贡献按包括商业授权在内的其他条款再许可（relicense），用于维持本项目的双轨授权模式。

不同意这两条就不要提交。已经合并的贡献，作者会在文件头保留你的署名。

---

## English summary

- **AGPL-3.0, no fee, for any purpose** — including commercial use — as long as you comply: ship the complete corresponding source of your modified version, and offer it to users who interact with it over a network.
- **A paid commercial license is only needed if you must keep your code proprietary.**
- Request one via an issue titled `[Commercial]` or contact [@TangkunNull](https://github.com/TangkunNull).
- Third-party components (Node.js, Flutter, community plugins) remain under their own licenses — see [NOTICE.md](NOTICE.md).
- By submitting a contribution you agree to license it under AGPL-3.0 and grant the author the right to relicense it, including commercially.
