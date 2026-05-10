# SinglePoint Calls — Administrator Training Manual

**Version:** 1.0  
**Product:** SinglePoint Calls Answering Service Platform  
**Audience:** System Administrators  
**Last updated:** May 2026

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Logging In as Administrator](#2-logging-in-as-administrator)
3. [Admin Console Overview](#3-admin-console-overview)
4. [Managing Clients](#4-managing-clients)
5. [Managing Operators](#5-managing-operators)
6. [Departments](#6-departments)
7. [DID Management](#7-did-management)
8. [IVR Builder](#8-ivr-builder)
9. [Scheduling & Shift Management](#9-scheduling--shift-management)
10. [Routing Rules](#10-routing-rules)
11. [Operator Skills](#11-operator-skills)
12. [Do Not Call (DNC) Registry](#12-do-not-call-dnc-registry)
13. [Voicemail Boxes](#13-voicemail-boxes)
14. [Call Monitoring & Recordings](#14-call-monitoring--recordings)
15. [Transcription Management](#15-transcription-management)
16. [Analytics & Reporting](#16-analytics--reporting)
17. [Billing & Invoices](#17-billing--invoices)
18. [Audit Log](#18-audit-log)
19. [System Settings](#19-system-settings)
20. [Noticeboard](#20-noticeboard)
21. [Security & Compliance](#21-security--compliance)
22. [Troubleshooting](#22-troubleshooting)

---

## 1. Introduction

SinglePoint Calls is a professional answering service platform built on Asterisk/FreePBX. It enables a team of operators (PAs) to answer calls on behalf of multiple client businesses, take messages, manage appointments, and deliver notifications via email, SMS, WhatsApp, and webhook.

As an **Administrator**, you have full access to:
- Create and configure client accounts
- Hire and manage operator accounts
- Define routing rules, IVR menus, and business hours
- View all analytics, billing, and audit records
- Configure system-wide settings

---

## 2. Logging In as Administrator

1. Navigate to your SinglePoint Calls URL (e.g. `https://your-domain.com`)
2. Enter your **username** and **password**
3. If Two-Factor Authentication (TOTP) is enabled on your account:
   - Enter your username/password and click **Sign In**
   - When prompted, open your authenticator app and enter the 6-digit code
   - Click **Verify**

> **Default admin credentials (change immediately after first login):**  
> Username: `leon123` | Password: `@leon123`

**To change your password:**  
Top-right menu → **Change Password** → enter current password + new password (min 12 chars, must include uppercase, lowercase, number, and special character).

**If you forget your password:**  
Use the "Forgot Password?" link on the login screen. A reset link will be emailed to your registered address.

---

## 3. Admin Console Overview

After logging in, click **Admin** in the top navigation bar. The admin section has a left sidebar with grouped categories:

| Group | Items |
|-------|-------|
| **Clients** | Clients, Client Portal Users, DID Numbers, Webhooks |
| **Staff** | Operators, Departments, Routing Rules, Op Skills, Shifts, Op Performance |
| **Telephony** | Voicemail Boxes, IVR Builder, Call Monitoring, Recordings, Transcription |
| **Messaging** | Bulk SMS |
| **Reporting** | Analytics, Leaderboard, Billing |
| **System** | Settings, Noticeboard, Audit Log, DNC List |

**Search the admin menu:** Type in the search box at the top of the sidebar to filter items instantly.

**Mobile navigation:** On mobile/tablet, tap the menu icon (☰) at the top-left to open the sidebar drawer.

---

## 4. Managing Clients

### Creating a New Client

1. Go to **Admin → Clients**
2. Click **+ Add Client**
3. Fill in the required fields:
   - **Business Name** — displayed on operator screens
   - **Phone** — contact number
   - **Address** — business address
   - **Timezone** — used for business hours calculations
4. Click **Save**

### Client Configuration

After creating a client, click the client row to expand settings:

#### DIDs (Phone Numbers)
- Add phone numbers that route to this client
- Go to **Admin → DID Numbers**, click **+ Add DID**, select the client

#### Business Hours (Opening Times)
- In the client detail, click **Opening Times**
- Set open/close times per day of the week
- Leave a day empty = closed that day
- Leave all days empty = always open (24/7)

#### Delivery Actions
Configure how messages are delivered for this client:
- **Email** — sends notification to contact's email
- **SMS** — sends SMS via Twilio
- **Webhook** — POSTs JSON to a URL
- **In-App** — stores in portal inbox
- **WhatsApp** — sends via WhatsApp Business API

#### Per-Client SMTP
If this client needs email sent from their own address:
- Expand **Email Settings** in the client detail
- Enter their SMTP host, port, username, and password

#### SLA Settings
Set message response SLA time (in minutes). Operators are alerted when an unacknowledged message exceeds this threshold.

#### Data Retention
Set how many months of data to retain before GDPR purge. Default is 24 months (configurable in System Settings).

### Editing a Client
Click the pencil icon on any client row. All fields are editable.

### Deactivating a Client
Toggle the **Active** switch on the client. Inactive clients stop receiving calls (their DIDs are not matched).

---

## 5. Managing Operators

### Creating an Operator Account

1. Go to **Admin → Operators**
2. Click **+ Add Operator**
3. Fill in:
   - **Full Name**
   - **Username** (unique, lowercase)
   - **Email**
   - **Password** (min 12 chars, uppercase + lowercase + number + special char)
   - **Role**: `operator`, `supervisor`, or `admin`
   - **Extension** — their SIP extension number in Asterisk
4. Click **Save**

### Roles Explained

| Role | Access |
|------|--------|
| `operator` | Call handling, messaging, own status/reports |
| `supervisor` | All operator access + view all operators' reports, QA scoring |
| `admin` | Full system access including admin console |

### Resetting an Operator Password

1. Go to **Admin → Operators**
2. Click the operator row
3. Click **Reset Password**
4. Enter and confirm the new password (must meet policy)

### Enabling/Disabling Two-Factor Authentication

1. Go to **Admin → Operators**, click the operator
2. Click **Security** tab
3. Toggle **Require TOTP** — they will be prompted to set up an authenticator app on next login

### Managing Operator Skills

Each operator can be assigned skills (e.g. "Medical", "Legal", "Bilingual-French"):
1. Go to **Admin → Op Skills**
2. In the Skills Catalog section, add skill names
3. In the Per-Operator section, select an operator and toggle their skills on/off

### Viewing Operator Performance

1. Go to **Admin → Op Performance**
2. Select an operator from the dropdown
3. Select a time period: Today, Week, Month, Year
4. View:
   - Calls handled, messages taken, average call duration
   - **Status Time Breakdown** — bar chart and table showing time spent in each status (Available, Break, Lunch, etc.)

---

## 6. Departments

Departments group operators for routing purposes.

1. Go to **Admin → Departments**
2. Click **+ Add Department**
3. Name the department (e.g. "Medical Team", "Night Shift")
4. Add operators to the department

Departments are referenced in **Routing Rules** to direct specific client calls to specific teams.

---

## 7. DID Management

DIDs (Direct Inward Dial numbers) route inbound calls to client accounts.

1. Go to **Admin → DID Numbers**
2. Click **+ Add DID**
3. Enter the phone number in E.164 format (e.g. `+441234567890`)
4. Select the **Client** this number belongs to
5. Click **Save**

Multiple DIDs can be assigned to one client. When a call arrives on a DID, the system identifies the client and shows operators the correct screenpop/greeting.

---

## 8. IVR Builder

Build interactive voice response menus for clients.

1. Go to **Admin → IVR Builder**
2. Select a client, click **+ New IVR Flow**
3. Give the flow a name and description
4. Add menu nodes:
   - **Prompt** — what audio plays
   - **Key mappings** — which digit routes where (transfer, voicemail, department, another menu)
5. Click **Save Flow**
6. Assign the IVR flow to a DID in DID Management

---

## 9. Scheduling & Shift Management

### Creating Shifts

1. Go to **Admin → Shifts**
2. Click **+ Add Shift**
3. Set the shift name, start time, end time, and days of week
4. Assign operators to the shift

### Time-Off Requests

Operators can submit time-off requests via their profile. Admins/supervisors review these:
1. Go to **Admin → Shifts**, click **Time-Off Requests** tab
2. Review pending requests, click **Approve** or **Reject**

---

## 10. Routing Rules

Routing rules direct incoming calls from specific clients (or all clients) to specific departments or operators.

1. Go to **Admin → Routing Rules**
2. Click **+ Add Rule**
3. Configure:
   - **Client** (or "All Clients")
   - **Department** or specific **Operator**
   - **Priority** (lower number = higher priority)
   - **Active hours** (optional — applies only during set hours)
4. Click **Save**

Rules are evaluated in priority order. The first matching rule wins.

---

## 11. Operator Skills

Skills enable skill-based routing — calls can be directed to operators who have the matching skill for a client.

**Managing the Skills Catalog:**
1. Go to **Admin → Op Skills**
2. In the **Skills Catalog** panel, type a skill name and click **Add**
3. To remove a skill, click the × next to it

**Assigning Skills to Operators:**
1. In the **Operator Skills** panel, select an operator
2. Check/uncheck skills from the list
3. Changes save automatically

---

## 12. Do Not Call (DNC) Registry

The DNC list prevents calling or messaging numbers that have opted out.

1. Go to **Admin → DNC List**
2. **Add a number:** Enter in E.164 format, click **Add**
3. **Check a number:** Enter a number and click **Check** — the system confirms whether it's listed
4. **Remove a number:** Click the **Remove** button next to any listed number

The DNC check runs automatically before outbound SMS and callbacks.

---

## 13. Voicemail Boxes

1. Go to **Admin → Voicemail Boxes**
2. Click **+ Add Voicemail Box**
3. Configure:
   - **Box number** (numeric)
   - **Client** this box belongs to
   - **Email notification** — address to forward transcribed voicemail messages
   - **PIN** — 4–8 digits for operator access
4. Click **Save**

Voicemails are automatically transcribed if the transcription service is configured (see System Settings → Transcription API Key).

---

## 14. Call Monitoring & Recordings

### Live Monitoring

1. Go to **Admin → Call Monitoring**
2. Active calls are listed in real-time
3. Click **Listen** to silently monitor a call
4. Click **Whisper** to speak to the operator without the caller hearing
5. Click **Barge** to join the call as a three-way conference

### Call Recordings

1. Go to **Admin → Recordings**
2. Search by date range, client, or operator
3. Click **Play** to listen in browser
4. Click **Download** to save the recording
5. Click **Delete** to permanently remove (requires admin role)

> **Note:** Recordings are stored per your data retention policy. They are automatically purged after the configured retention period.

---

## 15. Transcription Management

1. Go to **Admin → Transcription**
2. View all calls with recording URLs
3. For each call:
   - If transcribed, the text is shown
   - Click **Transcribe** to trigger transcription for a single call
4. Click **Batch Transcribe** to process all untranscribed calls with recordings

Configure the transcription API key in **Admin → System Settings → Transcription**.

---

## 16. Analytics & Reporting

### Dashboard Analytics

1. Go to **Admin → Analytics**
2. Select date range and client (or "All Clients")
3. View metrics:
   - Total calls, answered calls, missed calls
   - Average handle time, first-call resolution rate
   - Message volume by channel (email, SMS, etc.)
   - Hourly/daily call distribution charts
   - SLA compliance percentage

### Leaderboard

1. Go to **Admin → Leaderboard**
2. View operator rankings by calls handled, messages sent, QA scores
3. Select time period: Today, Week, Month, Year

### Operator Status Time Reports

1. Go to **Admin → Op Performance**
2. Select operator + period
3. The **Status Time Breakdown** section shows:
   - Bar chart of time in each status
   - Table with duration and percentage per status

### Exporting Data

- **Audit log:** Admin → Audit Log → click **Export CSV**
- **Call logs:** available via API at `GET /api/calls?format=csv`
- **GDPR Data Export:** available for portal users via their portal

---

## 17. Billing & Invoices

1. Go to **Admin → Billing**
2. View billing reports by client and period
3. Click **View Invoice** to open a printable HTML invoice
4. Click **Download** to save as HTML

Billing is calculated based on call minutes, message counts, and any fixed fees configured per client.

---

## 18. Audit Log

The audit log records every significant action taken in the system (logins, data access, changes, deletions). It is append-only and cannot be modified.

1. Go to **Admin → Audit Log**
2. Filter by date range, operator, or action type
3. Each entry shows: timestamp, operator, action, resource, IP address
4. Click **Export CSV** to download for compliance review

**Retention:** Audit log entries are kept indefinitely and are not subject to the client data retention policy.

---

## 19. System Settings

Go to **Admin → Settings** to configure:

| Setting | Description |
|---------|-------------|
| Company Name | Shown in email headers and portal branding |
| JWT Token Lifetime | How long operator sessions last (minutes) |
| Max Login Attempts | Lockout threshold before account lock |
| Default Timezone | System-wide timezone for new clients |
| SMTP From Name | Display name for outbound emails |
| Transcription API Key | API key for voicemail/call transcription service |
| Twilio Account SID / Auth Token | SMS delivery credentials |
| VAPID Keys | Web push notification keys |
| Data Retention Default | Default months before GDPR purge |

Click **Save Settings** after making changes.

---

## 20. Noticeboard

Post announcements visible to all operators on their dashboard.

1. Go to **Admin → Noticeboard**
2. Click **+ Post Notice**
3. Enter title and body text (supports markdown)
4. Set **Expiry Date** (optional — notice disappears after this date)
5. Click **Post**

To remove a notice, click the **Delete** button next to it.

---

## 21. Security & Compliance

### Password Policy

All accounts must use passwords that meet the following requirements:
- Minimum 12 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number
- At least one special character (`!@#$%^&*` etc.)

### Two-Factor Authentication (TOTP)

Strongly recommended for all admin accounts:
1. Go to your profile (top-right menu) → **Security**
2. Click **Set Up Two-Factor Auth**
3. Scan the QR code with an authenticator app (Google Authenticator, Authy, etc.)
4. Enter the 6-digit code to confirm
5. Save your backup codes in a secure location

### Rate Limiting

The system enforces rate limits on authentication:
- Login: 10 attempts per 15-minute window per IP
- TOTP verification: 10 attempts per 15-minute window per IP
- API endpoints: 200 requests per minute per IP

Accounts are not permanently locked — limits reset after the window expires.

### GDPR Data Export

Clients (via portal) or admins can export all data held for a contact:
- Portal: **Account** → **Export My Data**
- Admin: via API `GET /api/portal/data-export` with portal auth token

### Webhook Security

When configuring client webhooks, only public HTTPS URLs are accepted. Private/internal network addresses are blocked to prevent SSRF attacks.

### Session Management

Operator sessions expire after the configured JWT lifetime (default: 480 minutes / 8 hours). Sessions are invalidated on password change.

---

## 22. Troubleshooting

### Operator can't log in

1. Check the operator exists in **Admin → Operators**
2. Verify their account is not locked (check audit log for failed login attempts)
3. Reset their password if needed
4. Check they're entering username (not email)

### Calls not routing to operators

1. Verify the DID is registered in **Admin → DID Numbers** and linked to a client
2. Check that routing rules are configured
3. Verify Asterisk ARI connection: check server logs for `[ARI] Connected` message
4. Ensure operators are in **Available** status

### Messages not being delivered

1. Go to **Admin → Clients**, find the client, check **Delivery Actions** settings
2. For email: verify SMTP settings in **System Settings** or per-client SMTP override
3. For SMS: check Twilio credentials in **System Settings**
4. Check the **message_deliveries** records via the API for error messages

### Transcription not working

1. Check **Admin → Settings → Transcription API Key** is set and valid
2. Verify the recording URL is accessible from the server
3. Manually trigger transcription via **Admin → Transcription → Transcribe**

### Performance issues

1. Check **Admin → Analytics** for unusual call/message volume
2. Review server logs for database connection pool exhaustion
3. Check `GET /api/health` for system status indicators

---

*For further assistance, contact SinglePoint Calls support or raise an issue at your designated support channel.*
