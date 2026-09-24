# Authority and delegation

The configured authority is intentionally explicit. A missing permission means stop and ask.

| Action | Granted |
|---|---:|
| Write repository files | true |
| Use network | false |
| Create commits | false |
| Push remote branches | false |
| Publish releases | false |
| Deploy | false |

Delegated work must name its paths, expected result, allowed tools, checks, and stopping condition. The delegating agent must verify returned evidence itself. A worker report is a claim until checked.
