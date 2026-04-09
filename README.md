# opencli-easyconnect

An [OpenCLI](https://github.com/jackwener/opencli) adapter that automates
[Sangfor EasyConnect](https://www.sangfor.com.cn/) VPN login via a Docker
container and headless Playwright.  Works on macOS, Linux, and Windows.

## How it works

```
opencli easyconnect login
       │
       ├─ starts the hagb/docker-easyconnect container (Docker / OrbStack)
       ├─ launches headless Chromium → navigates to the VPN portal
       ├─ fills username + password from config / Keychain
       ├─ waits for SMS verification, reads code from macOS Messages (chat.db)
       └─ submits code → VPN is online
```

No browser extension required.  SMS codes are read automatically on macOS; on
other platforms supply them via `--sms-code`.

## Prerequisites

| Tool | Notes |
|------|-------|
| [Docker](https://www.docker.com/) or [OrbStack](https://orbstack.dev/) | Container runtime |
| [Node.js](https://nodejs.org/) ≥ 18 | Runs the adapter |
| [opencli](https://github.com/jackwener/opencli) | CLI framework |
| macOS Full Disk Access for Terminal | SMS auto-read from Messages (optional) |

## Installation

```bash
git clone https://github.com/asdmoment/opencli-easyconnect
cd opencli-easyconnect
bash install.sh
```

Then edit `~/.config/easyconnect/config.toml` (created by the installer):

```toml
[vpn]
url = "https://vpn.your-organization.com"

[auth]
username = "your_username"
```

Store your password in the macOS Keychain (never in the config file):

```bash
security add-generic-password -s easyconnect -a your_username -w
```

On Linux use `secret-tool`:

```bash
secret-tool store --label="EasyConnect VPN" service easyconnect username your_username
```

## Usage

```bash
opencli easyconnect login              # headless login (auto SMS)
opencli easyconnect login --visible    # show browser window
opencli easyconnect login --sms-code 123456   # supply SMS code manually

opencli easyconnect status             # container + tunnel health
opencli easyconnect stop               # stop the container
opencli easyconnect logs               # tail runtime logs
opencli easyconnect config             # show resolved configuration
opencli easyconnect doctor             # check prerequisites
```

## Configuration

Config file: `~/.config/easyconnect/config.toml`  
See [`config.example.toml`](./config.example.toml) for all available options.

Credential resolution order:

1. `EASYCONNECT_PASSWORD` environment variable
2. macOS Keychain (`security find-generic-password -s easyconnect`)
3. Linux: `secret-tool lookup service easyconnect username <user>`
4. Windows: `cmdkey`

## Docker image

Uses [`hagb/docker-easyconnect`](https://github.com/hagb/docker-easyconnect)
(`7.6.7` by default).  Override with `[container].image` in config.

## License

MIT
