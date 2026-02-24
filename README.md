# Custom Answering Service

A custom telephone answering service platform built on Node.js + Asterisk ARI, replacing ncall/nsolve.

## Stack

- **Backend:** Node.js + Express
- **Database:** PostgreSQL
- **Telephony:** Asterisk ARI (REST Interface)
- **Real-time:** Socket.io
- **Message Delivery:** SMTP email + Webhook push

## Architecture

```
Asterisk (FreePBX)
    └── ARI WebSocket ──► Node.js App
                              ├── REST API (Express)
                              ├── Real-time events (Socket.io)
                              └── PostgreSQL
                                    ├── clients
                                    ├── contacts
                                    ├── messages
                                    ├── call_logs
                                    └── operators
```

## Quick Start

### 1. Prerequisites

- Node.js >= 18
- PostgreSQL
- Asterisk with ARI enabled (`/etc/asterisk/ari.conf`)

### 2. Configure Asterisk ARI

In `/etc/asterisk/ari.conf`:
```ini
[general]
enabled=yes
pretty=yes

[asterisk]
type=user
read_only=no
password=your_ari_password
```

In `/etc/asterisk/extensions.conf`, send inbound calls into the Stasis app:
```ini
[from-trunk]
exten => _X.,1,Stasis(answering-service)
```

### 3. Install & Configure

```bash
npm install
cp .env.example .env
# Edit .env with your settings
```

### 4. Set Up Database

```bash
createdb answering_service
npm run migrate
npm run seed   # Creates a default admin operator
```

### 5. Run

```bash
npm start        # Production
npm run dev      # Development (auto-reload)
```

Open `http://localhost:3000` for the operator console.

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Operator login |
| GET | /api/clients | List clients |
| POST | /api/clients | Create client |
| GET | /api/clients/:id | Get client details |
| PUT | /api/clients/:id | Update client |
| GET | /api/clients/:id/contacts | List contacts |
| POST | /api/clients/:id/contacts | Add contact |
| GET | /api/messages | List messages |
| POST | /api/messages | Create message |
| PUT | /api/messages/:id/deliver | Trigger delivery |
| GET | /api/calls | Call log |
| GET | /api/operators | List operators |
| POST | /api/operators | Create operator |

## Operator Console

The web-based operator console (`/`) provides:
- Live call queue with Asterisk events via Socket.io
- Client script display per inbound DID
- Message taking form with structured fields
- Message history and delivery status
- Client and contact management
