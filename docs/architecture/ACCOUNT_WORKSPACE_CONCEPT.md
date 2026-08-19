# Animastor Account & Workspace Concept

**Status:** Concept / Architecture Direction  
**Purpose:** Define a simple, low-friction identity and workspace model for Animastor, with a natural path from anonymous use to persistent personal and team workspaces.

---

## 1. Philosophy

Animastor is a creative environment for building animated books. Authentication should therefore be a support mechanism, not a barrier to creativity.

The guiding principles are:

1. A new user should be able to start working immediately.
2. Registration should appear when the user's work has acquired meaningful value.
3. A user should never lose a book merely because the browser was closed, updated, or restarted.
4. PostgreSQL is the source of truth for identity, ownership, permissions, and application state.
5. The filesystem stores bytes; it does not decide who is allowed to access them.
6. Content hashes, build IDs, artifact IDs, and checksums identify content/artifacts but are never security credentials.
7. Personal work and collaborative work should use the same underlying workspace model.
8. Billing should be associated with a workspace/plan, not baked into the identity system.
9. The initial authentication system should be deliberately small and extensible.

---

## 2. No Shared Sandbox

Animastor should **not** provide a global shared anonymous filesystem.

A shared sandbox would create unnecessary ambiguity and security problems:

- identical books could resolve to the same content;
- hashes/build IDs could accidentally expose another user's project;
- ownership would become unclear;
- cleanup would become difficult;
- collaboration and accidental access would be mixed together.

Instead, every first-time visitor receives a private anonymous identity and a private temporary workspace.

---

## 3. Anonymous User

On first use:

```text
Visitor
   |
   v
Anonymous User
   |
   v
Temporary Personal Workspace
```

The anonymous identity is created server-side.

The browser stores only the session/identity credential required to reconnect to that workspace.

The actual book data remains on the server.

Therefore:

- browser refresh does not destroy the book;
- Chrome restart does not destroy the book;
- Android app/browser updates do not destroy the server-side workspace;
- local browser storage is not the authoritative copy.

The browser may still maintain local cache/drafts for convenience, but local storage must never be the only copy of meaningful work.

---

## 4. Temporary Workspace

The anonymous user receives a normal workspace structurally similar to a permanent personal workspace.

Conceptually:

```text
Anonymous User
    |
    +-- Temporary Workspace
            |
            +-- Projects
            +-- Books
            +-- Scenes
            +-- Imagination Units
            +-- Generated Artifacts
```

The important difference is persistence policy.

A temporary workspace may have:

- limited lifetime;
- limited storage;
- limited number of projects;
- limited generation/GPU usage;
- automatic expiration after inactivity.

Suggested lifecycle:

```text
ACTIVE
  |
  | inactivity
  v
EXPIRED
  |
  | grace period
  v
DELETED
```

Exact limits are intentionally left open until the real storage and GPU economics are reviewed.

---

## 5. Persistent Account

When the user decides that the workspace is worth keeping, they create an account.

The most important UX property is:

> **The existing workspace is preserved in place.**

There should be no export/download/re-upload cycle.

Conceptually:

```text
Anonymous User
      |
      | Create account
      v
Permanent User
      |
      v
Existing Workspace becomes permanent
```

The book, scenes, images, audio, video, metadata, and generation history remain where they already are.

Only the ownership/identity relationship changes.

---

## 6. Simple Registration

Initial account creation should require only:

```text
Username
Password
Confirm password
```

Email is optional:

```text
Email (optional)
```

Suggested explanatory text:

> Add your email if you want to recover your account if you forget your password.

The username supplied by the user may be made unique by adding a short generated suffix:

```text
Sergey
   |
   v
Sergey_7F3A
```

The generated suffix is a public uniqueness mechanism, not the internal security identity.

The internal user ID should be a separate opaque identifier.

---

## 7. Password Security

Passwords must never be stored in plaintext.

Store a strong password hash using a modern password hashing scheme such as Argon2id (or an equivalent approved implementation).

If the user forgets the password, Animastor must not send the original password by email.

Instead:

```text
Forgot password
      |
      v
Recovery / reset flow
      |
      v
Set a new password
```

Email, when present, is a recovery channel.

---

## 8. Recovery Key

For users who do not provide an email, Animastor should offer a recovery key.

Example:

```text
K7XM-4PQA-92LF-8TNR
```

The key should be:

- generated randomly;
- sufficiently long to resist guessing;
- shown to the user once;
- encouraged to be stored somewhere safe;
- never stored in plaintext on the server;
- stored only as a secure hash.

The user should be clearly informed:

> Without an email or recovery key, a forgotten password may be impossible to recover.

The recovery key is not a normal login password. It is an emergency account-recovery credential.

---

## 9. User vs Workspace

Authentication and ownership should be separate concepts.

A user represents a person/identity.

A workspace represents the place where projects and resources belong.

Conceptually:

```text
User
 |
 +-- Personal Workspace
 |
 +-- Team / Organization Workspaces
```

This allows the same account model to support:

- individual users;
- free users;
- paid users;
- teams;
- studios;
- collaborative book projects.

---

## 10. Suggested Core Database Model

The exact schema must be adapted to the existing Animastor PostgreSQL/BKN database after inspection.

Conceptual entities:

```text
users
-----
id
username
password_hash
email
recovery_key_hash
created_at
...

workspaces
----------
id
name
owner_user_id
plan
created_at
...

workspace_members
-----------------
workspace_id
user_id
role
...

books
-----
id
workspace_id
title
...
```

The existing Animastor tables should be connected to the workspace hierarchy rather than duplicating ownership information everywhere.

Preferred ownership chain:

```text
User
  |
  v
Workspace
  |
  v
Book
  |
  +-- Scenes
  +-- Imagination Units
  +-- Characters
  +-- Voices
  +-- Locations
  +-- Generated Artifacts
  +-- Generation Jobs
```

The exact existing relationships must be inspected before implementation.

---

## 11. PostgreSQL as Source of Truth

PostgreSQL should be authoritative for:

- users;
- authentication-related identity records;
- workspace ownership;
- workspace membership;
- permissions;
- books/projects ownership;
- generation jobs and persistent state;
- relevant quotas/limits;
- billing-related workspace state when billing is introduced.

Redis may continue to serve fast operational state.

The filesystem should not become a second ownership database.

Core principle:

> **PostgreSQL knows what a resource is and who may access it. The filesystem stores the bytes.**

---

## 12. Filesystem Ownership

A conceptual storage layout may eventually look like:

```text
storage/
    workspaces/
        <workspace_id>/
            books/
                <book_id>/
                    source/
                    images/
                    audio/
                    video/
                    artifacts/
```

The exact physical layout is implementation-dependent.

The backend must construct trusted filesystem paths from database records.

The frontend must never be allowed to define arbitrary filesystem paths.

For a request such as:

```text
GET /books/<book_id>
```

the backend should:

1. authenticate the user/identity;
2. resolve the workspace;
3. verify membership/ownership;
4. verify permission for the requested resource;
5. construct the filesystem path internally;
6. return the resource.

A hash or build ID alone must never grant access.

---

## 13. Hashes, Build IDs, and Security

Animastor already uses content verification, hashes, build IDs, and related mechanisms.

These remain useful, but their purpose must remain distinct from authorization.

```text
content_hash
    -> What content is this?

artifact_id / artifact_hash
    -> Which artifact is this?

build_id
    -> Which generated build is this?

workspace_id
    -> Who owns this resource?

permission
    -> Is this user allowed to access it?
```

Never use:

```text
known hash == permission to access
```

This separation is especially important for shared storage and future collaboration.

---

## 14. Collaboration

Collaboration should not require shared accounts.

Each person keeps an individual account.

A workspace contains members:

```text
Workspace: Master & Margarita

Sergey     owner
Alex       editor
Maria      editor
Ivan       viewer
```

Conceptually:

```text
workspace_members
-----------------
workspace_id
user_id
role
```

Initial roles may be minimal:

- `owner`
- `editor`
- `viewer`

More detailed roles can be added later.

The important architectural decision is to introduce membership early, even if the first implementation only uses `owner`.

---

## 15. Personal and Team Workspaces

A user should automatically receive a personal workspace after creating a permanent account.

Later, the same user may belong to additional workspaces:

```text
Sergey

Personal
  My Workspace

Teams
  Animastor Studio
  M&M Project
```

The same authentication identity is reused everywhere.

There is no need for separate "personal accounts" and "corporate accounts".

---

## 16. Billing

Billing should not be embedded into the authentication model.

The conceptual relationship is:

```text
User
  |
  v
Workspace
  |
  +-- plan
  +-- storage limits
  +-- GPU limits
  +-- credits
  +-- billing
```

For example:

```text
Free
Pro
Studio
Enterprise
```

These are workspace plans rather than different classes of users.

This allows a person to remain the same identity while moving between personal and team workspaces with different plans.

Billing implementation is intentionally outside the first authentication phase.

---

## 17. Guest-to-Account Conversion

The transition should feel like saving work rather than registering for a service.

Primary action:

> **Keep my workspace**

Possible UI:

```text
Create your Animastor account

Username
[ Sergey ]

Password
[ ******** ]

Confirm password
[ ******** ]

Email (optional)
[                 ]

[ Create account ]
```

After successful creation:

```text
Anonymous Workspace
        |
        v
Permanent Personal Workspace
```

No project migration should be necessary.

---

## 18. When Should Animastor Ask for Registration?

Registration should not necessarily appear immediately.

The system should estimate whether the user has created meaningful value.

Potential signals:

### Low value

- opened a new book;
- uploaded a file but did little with it;
- made a few exploratory edits;
- created temporary/random content.

Action:

> Do not interrupt the user.

### Medium value

- meaningful text edits;
- multiple scenes;
- imagination units created;
- characters/voices/locations configured;
- project saved and revisited.

Action:

> Softly suggest keeping the workspace.

### High value

- successful image generation;
- successful audio generation;
- successful video generation;
- multiple generated artifacts;
- significant time invested;
- substantial project growth.

Action:

> Strongly recommend creating an account.

The exact scoring system is not yet defined.

A conceptual internal value score may eventually be useful:

```text
uploaded book             +1
meaningful edit           +1
created scene             +1
created imagination unit  +1
successful image          +3
successful audio          +3
successful video          +5
multiple scenes           +2
```

These values are illustrative only.

The actual implementation should be based on real Animastor workflows and infrastructure costs.

---

## 19. Registration UI

The account/workspace control should live in the familiar top-right area next to application settings.

Conceptually:

```text
[ User / Workspace ] [ Settings ]
```

The user/workspace icon should be a simple user-circle/person SVG rather than a group icon.

The two controls have different meanings:

```text
User / Workspace
    -> Who am I?
    -> Which workspace am I using?
    -> Account
    -> Workspace switching
    -> Sign out

Settings
    -> How does the application behave?
```

Do not mix these concepts.

---

## 20. Anonymous User Menu

Example:

```text
Anonymous

Temporary workspace

----------------

Keep my workspace
Create account

----------------

Workspace
  My temporary book

----------------

Settings
```

The exact UI is subject to the existing Animastor design system.

---

## 21. Permanent User / Workspace Menu

Example:

```text
Sergey_7F3A

Personal workspace
  My Workspace

----------------

Teams
  Animastor Studio
  M&M Project

----------------

Account
Settings
Sign out
```

This establishes the future workspace-switching pattern without requiring the entire collaboration system to exist initially.

---

## 22. Browser Persistence

The browser should store only the information necessary to reconnect to the anonymous/permanent identity.

Important rule:

> **The browser is not the database.**

Server-side data should survive:

- browser restart;
- Android process termination;
- Chrome restart;
- browser update;
- normal cache cleanup.

A local browser cache may improve UX but must not be the sole copy of a book.

Session/identity persistence must be designed carefully around cookies/tokens and their expiration rules.

---

## 23. Temporary Workspace Retention

Exact limits remain to be determined.

Possible controls:

```text
Time since last activity
Storage used
Number of projects
Number of generated artifacts
GPU usage
```

A reasonable conceptual lifecycle is:

```text
Active
   |
   | inactivity threshold
   v
Expired
   |
   | grace period
   v
Deleted
```

Before expiration:

> Your temporary workspace is expiring soon. Create an account to keep it permanently.

The grace period provides protection against accidental loss without requiring unlimited storage.

---

## 24. Important Security Boundary

The following must remain separate:

```text
Authentication
    Who is the user?

Ownership
    Which workspace/resource belongs to whom?

Authorization
    What may this user do?

Content identity
    Which exact bytes/artifact are these?

Billing
    Which plan/credits apply?
```

Do not collapse these into a single identifier or mechanism.

---

## 25. Future Authentication Methods

The first version can use:

```text
username + password
```

The underlying identity model should nevertheless allow additional authentication methods later:

```text
username/password
email recovery
Google
GitHub
passkeys
other identity providers
```

These should be identities/authentication methods attached to the same user rather than separate user accounts.

This avoids an architectural rewrite when additional login methods are introduced.

---

## 26. Relationship to Animastor Architecture

The account/workspace model should fit the existing service architecture:

```text
Frontend
   |
   v
Backend API
   |
   +----------------------+
   |                      |
PostgreSQL              Redis
   |                      |
   |                  operational state
   |
ownership / state
   |
   +----------+
              |
         Filesystem
              |
         generated data

Backend
   |
   v
GPU Hub
   |
   v
Workers
```

The GPU Hub and workers should operate on trusted IDs such as:

```text
workspace_id
project_id
book_id
job_id
```

They should not independently decide whether a human user owns a resource.

Authorization belongs at the API/application boundary.

---

## 27. Design Principles to Preserve

### Principle 1 — Start working immediately

No mandatory registration wall.

### Principle 2 — Never make the browser the only storage

Anonymous work lives server-side.

### Principle 3 — Registration should preserve existing work

Account creation converts the existing workspace rather than creating a second copy.

### Principle 4 — Do not use hashes as authorization

Hashes identify content, not ownership.

### Principle 5 — User and workspace are different entities

This enables teams.

### Principle 6 — Billing belongs to workspaces

The same user can operate in different plans/workspaces.

### Principle 7 — Keep authentication small

Do not build enterprise IAM before it is needed.

### Principle 8 — Design for extension

Simple username/password today should not prevent Google/GitHub/passkeys tomorrow.

### Principle 9 — PostgreSQL is authoritative

Ownership and permissions must be database-backed.

### Principle 10 — Do not interrupt creativity unnecessarily

Registration prompts should correlate with the user's investment and the value of generated work.

---

## 28. Open Questions

The following should be resolved before implementation:

1. What are the exact current PostgreSQL tables related to books, projects, files, jobs, and BKN?
2. Where should `workspace_id` be introduced in the existing schema?
3. Which existing resources need explicit ownership fields?
4. What is the current canonical filesystem layout?
5. How should anonymous session tokens be persisted and rotated?
6. What should the anonymous workspace lifetime be?
7. What storage limit should anonymous workspaces have?
8. What GPU generation limit should anonymous users have?
9. What constitutes meaningful user value for registration prompts?
10. Should the value system be an actual stored score or derived from activity?
11. How long should expired anonymous workspaces remain in the grace period?
12. How should an anonymous workspace be recovered if its browser session is lost?
13. Which minimum collaboration roles are needed for the first team implementation?
14. What billing provider and credit model will eventually be used?
15. Which existing backend endpoints need authentication middleware?
16. Which existing filesystem/recovery mechanisms need to become workspace-aware?
17. How should API authentication work across web, Android, and future clients?

---

## 29. Proposed Implementation Phases

### Phase 1 — Identity Foundation

- users table/model;
- username/password authentication;
- password hashing;
- sessions/tokens;
- optional email;
- recovery key;
- basic login/logout;
- account menu.

### Phase 2 — Workspace Ownership

- personal workspace;
- anonymous workspace;
- workspace ownership;
- connect existing books/projects to workspace;
- authorization middleware;
- filesystem access through database ownership.

### Phase 3 — Guest Persistence

- anonymous workspace lifetime;
- storage/generation limits;
- expiration;
- grace period;
- "Keep my workspace" conversion;
- registration prompts based on meaningful activity.

### Phase 4 — Collaboration

- workspace members;
- roles;
- workspace switching;
- shared projects/books.

### Phase 5 — Billing

- workspace plans;
- GPU quotas/credits;
- storage quotas;
- payment provider;
- usage accounting.

### Phase 6 — Additional Identity Providers

Only when justified:

- Google;
- GitHub;
- passkeys;
- additional authentication methods.

---

## 30. Summary

The proposed Animastor identity architecture is intentionally simple:

```text
                    Visitor
                       |
                       v
                Anonymous User
                       |
                       v
             Temporary Workspace
                       |
              meaningful work
                       |
                       v
               "Keep workspace"
                       |
                       v
                  User Account
                       |
                       v
             Permanent Workspace
                       |
             +---------+---------+
             |                   |
         Personal              Team
         workspace            workspace
             |                   |
             +---------+---------+
                       |
                     Books
                       |
                  Generation
                       |
                    GPU Hub
```

The central architectural idea is:

> **Animastor should let people create first and identify themselves when their work becomes worth preserving.**

The account system should therefore be almost invisible during the creative process while still providing a strong, database-backed ownership model underneath.

This gives Animastor a simple first experience today and a clean path toward persistent personal workspaces, collaboration, GPU quotas, billing, and additional authentication methods later.
