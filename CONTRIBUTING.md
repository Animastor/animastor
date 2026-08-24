# Contributing to Animastor

Thank you for your interest in contributing to Animastor! This document provides guidelines for contributing to the project.

## Getting Started

1. **Fork the repository** and clone your fork locally.
2. **Install dependencies:**
   - Backend: `cd backend && npm install`
   - Web app: `cd frontends/app && npm install`
3. **Copy the environment file:** `cp .env.example .env` and configure as needed.
4. **Start services:** `docker compose up -d` (for PostgreSQL and Redis).

## Development Workflow

1. Create a feature branch from `master`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Make your changes in small, focused commits.
3. Run tests before submitting:
   ```bash
   cd backend && npm test
   ```
4. Push your branch and open a Pull Request.

## Code Style

- **Backend (Node.js):** Follow the existing code patterns. The backend uses CommonJS (`.cjs` files). Keep functions small and well-documented.
- **Frontend (Preact):** Follow existing component patterns in `frontends/app/`.
- **Android (Kotlin):** Follow existing patterns in `frontends/android/`.

## What to Contribute

- Bug fixes
- Documentation improvements
- New features that align with the project roadmap
- Test coverage improvements
- Performance optimizations

## Pull Request Guidelines

- Keep PRs focused on a single change.
- Include a clear description of what the PR does and why.
- Reference any related issues.
- Ensure all existing tests pass.
- Add tests for new functionality when possible.

## Reporting Issues

Open an issue on GitHub with:
- A clear title and description
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Environment details (OS, Node version, browser, etc.)

## Architecture Documentation

Before making significant changes, review the architecture documentation in [`docs/01-overview/ARCHITECTURE.md`](docs/01-overview/ARCHITECTURE.md) to understand the system's layers and conventions.

## Code of Conduct

Be respectful and constructive in all interactions. We are building a welcoming community for everyone interested in AI-powered storytelling.
