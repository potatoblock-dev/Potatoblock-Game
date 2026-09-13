# Potatoblock Game

[土豆方块](https://game.potatoblock.com) 的线上游戏门户与部署镜像。

玩家在这里登录、选游戏、断线重连；本仓库对应服务器上的应用目录（`/app`），由 CD 推送到 MCSManager。

**游玩：** [game.potatoblock.com](https://game.potatoblock.com)

---

## 现在有什么

| 入口 | 说明 |
|------|------|
| 阈限月台 | 合作多人平台 / 设施向玩法（源码在 [Liminal-Platform](https://github.com/Potatoblock-Dev/Liminal-Platform)） |
| 皮套大厅 | 装扮与大厅 |
| 你画我猜 | 经典你画我猜 |
| 画画接龙 | 轮流接画 |

音效授权见 [THIRD_PARTY_AUDIO.md](./THIRD_PARTY_AUDIO.md)（游戏音效均为 CC0）。

---

## 认证：Passport OAuth2/OIDC

登录唯一入口是 Passport 的 **Authorization Code + PKCE（S256）**，端点由
`https://passport.potatoblock.com/.well-known/openid-configuration` 发现，不在代码里硬编码。

| 路由 | 说明 |
|------|------|
| `GET /login?next=/game` | 生成 state / PKCE verifier / nonce 存 session → 302 到 Passport `/oauth/authorize` |
| `GET /pwa/login-done` | 回调：校验 state → 换 token → 验 id_token（JWKS / iss / aud / exp / nonce）→ 写本站 session |
| `POST /logout` | 清本站 session（Provider 无 end_session 端点，Passport SSO 仍然保持） |

本站 session 只存 `user_id` / `nickname` / `auth_time`，**不放任何 token**：
Starlette 的会话 Cookie 是签名可见而非加密，放 token 等于把凭证交给浏览器。

client 配置全部在 `config/site.yml`（**唯一配置来源，不读环境变量**；该文件属服务器本地文件，
与 `passport.api_key`、`secret_key` 一样不进 CD 推送的 `app/` 仓）：

```yaml
oauth:
  issuer: "https://passport.potatoblock.com"
  scope: "openid profile"
  local_profile: "localhost"        # localhost / 127.0.0.1 走哪个 profile
  clients:
    default:                        # 线上
      client_id: "potatoblock-game"
      client_secret: "<注册时一次性返回的 secret>"
      redirect_uri: "https://game.potatoblock.com/pwa/login-done"
    localhost:                      # 本地开发，端口须与注册值一致
      client_id: "potatoblock-game-dev"
      client_secret: "<dev client secret>"
      redirect_uri: "http://localhost:8000/pwa/login-done"
session:
  max_age: 604800    # 本站会话 7 天，与 Passport refresh_token_ttl 对齐
  https_only: false  # 生产 HTTPS 设 true
```

**`redirect_uri` 必须与 Passport 上注册的值逐字符一致**（Provider 精确匹配），改路径需先在 Passport 重新注册。
`client_secret` 未填时 `/login` 直接返回「通行证登录未配置」错误页（503），不会白屏或 500。

---

## 仓库角色（简要）

```
玩法 SoT（如 Liminal-Platform）──vendor──► 本仓 games/*
本仓 main ──CD──► MCS /app ──► game.potatoblock.com
```

- **本仓**：门户、挂载、整树部署；不把某个游戏的完整开发流程绑死在这里。
- **玩法源仓**：改月台 / 皮套等，先推 SoT，再 vendor 进 `games/`。
- **服务器本地、不进本仓：** `main.py`、`routers/`、`var/`、`.env` 等（实例入口与运行时数据）。

日常开发约定见各游戏目录的 `SOURCE.md`，以及协作侧的 deploy skill。

---

## 维护者：CD 与部署

`main` 有推送时，[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) 会跑 `deploy.py`：分包上传到 MCS、解压、重启实例。

### GitHub Secrets

| Secret | 说明 |
|--------|------|
| `MCSM_PANEL_URL` | 面板地址 |
| `MCSM_API_KEY` | API 密钥（面板须 `enableApiKey: true`） |
| `MCSM_DAEMON_ID` | 守护进程 UUID |
| `MCSM_INSTANCE_UUID` | 实例 UUID |

可选 Variables：`MCSM_UPLOAD_DIR`（默认 `/app`）、`MCSM_MAX_PART_BYTES` / `MCSM_UPLOAD_RETRIES` / `MCSM_UPLOAD_TIMEOUT`（大包分包与重试）。

面板 → 用户中心拿 API 密钥；实例详情复制 daemon / instance UUID。

### 手动部署

```bash
export MCSM_PANEL_URL="http://your-panel:23333"
export MCSM_API_KEY="…"
export MCSM_DAEMON_ID="…"
export MCSM_INSTANCE_UUID="…"
python deploy.py

MCSM_DRY_RUN=1 python deploy.py   # 只测连接
```

面板在内网时：用 self-hosted runner，或在能访问面板的机器上跑 `deploy.py`。

大包易被 daemon 掐断时，脚本会按体积分包；超限单文件（多为音频）直传。排障细节以协作文档 / `deploy.py` 注释为准。

### 不要做的事

- 用本地 stub 覆盖已有的 `deploy.py`、`.github/`、合作者维护的说明
- 把服务器独有文件强行塞进仓库
- 在玩法 SoT 尚未更新时，把本仓 `games/liminal_platform` 当唯一编辑面长期改
