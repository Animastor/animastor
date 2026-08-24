# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| Latest  | :white_check_mark: |
| < Latest | :x:               |

Only the latest version of Animastor receives security updates.

## Reporting a Vulnerability

If you discover a security vulnerability in Animastor, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use GitHub's private vulnerability reporting feature if available.

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment:** within 48 hours
- **Initial assessment:** within 1 week
- **Fix or mitigation:** timeline depends on severity

## Security Considerations

Animastor handles several security-sensitive areas:

- **Authentication:** Server-side sessions with scrypt password hashing
- **API Keys:** Workspace AI provider keys are encrypted at rest (AES-256-GCM)
- **Worker Credentials:** FAIL CLOSED model — invalid/missing credentials are rejected
- **HTTP Security:** Helmet.js headers (HSTS, CSP, X-Frame-Options)
- **Rate Limiting:** 500 req/min on API endpoints
- **SSRF Protection:** Endpoint validation on user-controlled URLs

## Best Practices for Deployment

- Use strong, unique values for `POSTGRES_PASSWORD` and `WORKSPACE_SECRET_KEY`
- Keep `.env` out of version control (it is in `.gitignore`)
- Use HTTPS in production (TLS certificates via Let's Encrypt)
- Restrict admin access to `admin.animastor.in` with Basic Auth
- Regularly update dependencies: `npm audit`
