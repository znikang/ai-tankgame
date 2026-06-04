# Tank Wars — Account System Design

## Overview

WebSocket-based account system using Redis as the persistence layer. Players register/login via Socket.IO events, earn a session token, and can query stats and leaderboards — all over the same WebSocket connection used for gameplay.

## Tech Stack

- **Runtime:** Node.js + Express + Socket.IO (existing)
- **Database:** Redis (new)
- **Auth:** bcrypt password hashing, random token sessions (TTL 7 days)
- **Client:** In-game login panel overlay (HTML/CSS/JS)

## Redis Data Structures

### `user:{username}` — Hash

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | Canonical username (lowercase) |
| `password_hash` | string | bcrypt hash |
| `display_name` | string | User-facing name |
| `created_at` | string | ISO timestamp |

### `user:stats:{username}` — Hash

| Field | Type | Description |
|-------|------|-------------|
| `score` | integer | Kill score (+5 kill, -10 death), can be negative |
| `wins` | integer | Times player survived to end |
| `losses` | integer | Times player died |
| `kills` | integer | Total kills dealt |
| `deaths` | integer | Total times killed |
| `shots_fired` | integer | Total shots fired |

### `session:{token}` — String

Value = `username`. TTL = 604800 seconds (7 days).

### Sorted Sets — Leaderboards

| Key | Member | Score |
|-----|--------|-------|
| `leaderboard:score` | username | score (descending) |
| `leaderboard:wins` | username | wins (descending) |
| `leaderboard:kills` | username | kills (descending) |

## Socket.IO Events

### Authentication

| Direction | Event | Payload | Response |
|-----------|-------|---------|----------|
| C→S | `auth:register` | `{ username, password, displayName }` | `auth:register` → `{ success, token, message }` |
| C→S | `auth:login` | `{ username, password }` | `auth:login` → `{ success, token, message }` |
| C→S | `auth:resume` | `{ token }` | `auth:resume` → `{ success, username, message }` |
| C→S | `auth:logout` | `{ token }` | `auth:logout` → `{ success }` |

### Stats

| Direction | Event | Payload | Response |
|-----------|-------|---------|----------|
| C→S | `stats:query` | `{ username }` | `stats:query` → `{ username, score, wins, losses, kills, deaths, shots_fired }` |
| C→S | `stats:me` | `{ token }` | `stats:me` → `{ username, score, wins, losses, kills, deaths, shots_fired }` |

### Leaderboard

| Direction | Event | Payload | Response |
|-----------|-------|---------|----------|
| C→S | `leaderboard:query` | `{ type: 'score'|'wins'|'kills', limit: 10 }` | `leaderboard:query` → `{ type, results: [{ username, score }] }` |

### Account Management

| Direction | Event | Payload | Response |
|-----------|-------|---------|----------|
| C→S | `account:changePassword` | `{ token, oldPassword, newPassword }` | `account:changePassword` → `{ success, message }` |
| C→S | `account:delete` | `{ token, password }` | `account:delete` → `{ success, message }` |

### Game Stats Update

| Direction | Event | Payload |
|-----------|-------|---------|
| S→C | `game:statsUpdate` | `{ username, score, wins, losses, kills, deaths }` |

## Score System

| Event | Score Change |
|-------|-------------|
| Player killed (dies) | -10 |
| Player kills enemy | +5 |
| Player survives to end | +10 |

Score can be negative. New accounts start at 0.

## Authentication Flow

1. **Register:** Client sends username + password + display name. Server checks if username exists, hashes password with bcrypt, creates `user:{username}` hash, generates random token, stores `session:{token}` = username (TTL 7d), responds with token.
2. **Login:** Client sends username + password. Server verifies bcrypt, generates new token, responds with token.
3. **Resume:** Client sends token on reconnect. Server checks `session:{token}`, responds with username if valid.
4. **Protected events:** Every game/stat event requires `{ token }` in payload. Server validates token before processing.
5. **Logout:** Client sends token. Server deletes `session:{token}`.

## Game Integration

When a player is killed:
- `deaths++`, `score -= 10` for the victim
- `kills++`, `score += 5` for the killer
- Emit `game:statsUpdate` to both players

When a player survives (no explicit end-condition):
- On server restart or admin reset: `wins++`, `score += 10` for survivors
- Update all three leaderboard sorted sets

## Security

- Passwords hashed with bcrypt (cost factor 12)
- Tokens are 32-byte random hex strings
- Session TTL: 7 days, auto-expire
- Username sanitized: lowercase, 3-20 chars, alphanumeric + underscore only
- Rate limiting on auth events: max 5 attempts per 30 seconds per socket

## Frontend UI

### Login Panel (overlay on canvas)

Shown when no valid token. Contains:
- Username input
- Password input
- Display name input (register only)
- Register button / Login button
- Tab switch between login/register

### Stats Panel

Modal showing current user's stats table.

### Leaderboard Panel

Modal showing top N players sorted by selected metric (score/wins/kills), with rank numbers.

### Logged-in Status

Small banner showing display name + stats/leaderboard buttons + logout.

## Dependencies

```json
{
  "ioredis": "^5.3.0",
  "bcrypt": "^5.1.1"
}
```

## Files to Create/Modify

| File | Action |
|------|--------|
| `server.js` | Add Redis client, auth middleware, socket events, score logic |
| `public/client.js` | Add auth events, UI panel rendering, stats/leaderboard modals |
| `public/index.html` | Add login panel HTML, modal containers, CSS |
| `docs/2026-06-04-account-system-design.md` | This spec |
| `README.md` | Add Redis setup instructions |
