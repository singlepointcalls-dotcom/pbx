# SinglePoint Calls — Operator / PA Training Manual

**Version:** 1.0  
**Product:** SinglePoint Calls Answering Service Platform  
**Audience:** Operators (Personal Assistants / Call Handlers)  
**Last updated:** May 2026

---

## Table of Contents

1. [Welcome & Your Role](#1-welcome--your-role)
2. [Logging In](#2-logging-in)
3. [The Operator Console](#3-the-operator-console)
4. [Setting Your Status](#4-setting-your-status)
5. [Handling Incoming Calls](#5-handling-incoming-calls)
6. [Taking a Message](#6-taking-a-message)
7. [Managing Messages](#7-managing-messages)
8. [Client Information (Screenpop)](#8-client-information-screenpop)
9. [Contacts & On-Call Schedules](#9-contacts--on-call-schedules)
10. [Appointments & Calendar](#10-appointments--calendar)
11. [Tasks](#11-tasks)
12. [Canned Responses](#12-canned-responses)
13. [Viewing Your Time & Performance](#13-viewing-your-time--performance)
14. [Real-Time Wallboard](#14-real-time-wallboard)
15. [QA Scores & Feedback](#15-qa-scores--feedback)
16. [Notifications & Alerts](#16-notifications--alerts)
17. [Account Settings](#17-account-settings)
18. [Two-Factor Authentication (TOTP)](#18-two-factor-authentication-totp)
19. [Tips for Excellent Service](#19-tips-for-excellent-service)
20. [Common Questions (FAQ)](#20-common-questions-faq)

---

## 1. Welcome & Your Role

As a **SinglePoint Calls Operator** (also called a PA — Personal Assistant), your role is to answer incoming calls on behalf of our client businesses. You are the voice of those businesses, so professionalism and accuracy are essential.

**Your core responsibilities:**
- Answer calls promptly and professionally
- Use the caller information shown on screen to greet and assist callers
- Take accurate messages and deliver them to the right contacts
- Manage your availability status honestly
- Follow each client's specific instructions (shown in the screenpop)

**What you need to get started:**
- Your username and password (provided by your administrator)
- A SIP softphone or desk phone configured with your extension
- A headset for clear audio quality
- Access to the SinglePoint Calls operator console URL

---

## 2. Logging In

1. Open your browser and go to the SinglePoint Calls URL provided by your administrator
2. Enter your **username** and **password**
3. Click **Sign In**

> **If Two-Factor Authentication is enabled on your account:**  
> After entering your username and password, you will be asked for a 6-digit code from your authenticator app. Open the app, find SinglePoint Calls, and enter the code shown.

### Forgotten Password

1. Click **"Forgot Password?"** on the login screen
2. Enter your username
3. Check your email for a password reset link
4. Click the link and enter your new password
5. Your new password must be at least 12 characters and include uppercase, lowercase, a number, and a special character

### First Login

On your first login, you may be prompted to change your password. Choose a strong password that you can remember.

---

## 3. The Operator Console

After logging in, you'll see the main operator console. Here's what each section does:

```
[SinglePoint Calls logo]   [Dashboard] [Messages] [Calls] [Appointments] [Contacts] [Tasks] [Admin]
                                                                        Status: ● Available ▼
```

### Top Navigation Bar

| Button | What it does |
|--------|-------------|
| **Dashboard** | Real-time call queue and incoming call alerts |
| **Messages** | All messages taken — view, acknowledge, search |
| **Calls** | Call log history |
| **Appointments** | Appointment calendar and booking |
| **Contacts** | Client contact directories |
| **Tasks** | Your assigned tasks |
| **Admin** | *(Admin/Supervisor only)* System configuration |

### Dashboard

The dashboard shows:
- **Active Calls panel** — calls currently ringing or in progress
- **Recent Messages** — the latest messages from all clients
- **Noticeboard** — announcements from your administrator

---

## 4. Setting Your Status

Your status tells the system (and supervisors) whether you are available to take calls. Always keep it accurate — routing decisions are based on your status.

### Status Options

| Status | Meaning |
|--------|---------|
| ● **Available** | Ready to take calls |
| ◐ **Break** | Short break (tea/coffee) |
| ◐ **Lunch** | Meal break |
| ◐ **Comfort** | Brief personal break |
| ◐ **Meeting** | In a meeting |
| ◐ **Training** | In training |
| ◐ **Admin** | Doing administrative work |
| ◑ **Busy** | On a call / occupied |
| ○ **Offline** | Not logged in / unavailable |

### Changing Your Status

1. Click your status indicator in the top-right corner (shows current status with a coloured dot)
2. Select the new status from the dropdown menu
3. Your status updates immediately across the whole system

> **Important:** When you take a break, set your status to the appropriate break type. When you return, **always set yourself back to Available** so calls can route to you.

### Viewing Your Time Today

To see how long you've spent in each status today:
1. Click your status indicator in the top-right
2. Click **⏰ My Time Today** at the bottom of the menu
3. A panel opens showing time in each status with a bar chart
4. Use the tabs to switch between Today, This Week, This Month, This Year

---

## 5. Handling Incoming Calls

### When a Call Arrives

When a new call comes in, you'll hear an alert sound and see a notification on the Dashboard:

```
📞 INCOMING CALL
Client: Smith & Partners Solicitors
Caller: +44 1234 567890
DID: +44 7700 900001
[Answer]  [View Details]
```

The system automatically loads the **screenpop** — the client's profile showing:
- Client name and business description
- Greeting script (how to answer)
- Special instructions
- Recent messages for this client

### Answering a Call

1. Click **Answer** (or press the answer button on your phone/softphone)
2. The system bridges the call to your SIP extension
3. Greet the caller using the script shown in the screenpop
4. The active call appears in your **Active Calls** panel

### Typical Greeting

Use the greeting shown in the screenpop. If none is set, use the default:

> *"Good [morning/afternoon], [Client Business Name], you're speaking with [Your Name], how can I help you today?"*

### During the Call

- Keep the screenpop panel visible — it shows instructions and contact information
- If you need to check contacts or appointments, use the tabs in the screenpop
- Take notes — you'll convert these into a message after the call

### Ending a Call

When the caller hangs up, the call ends automatically. The screenpop remains open so you can take a message.

If you need to end the call:
1. Say goodbye to the caller
2. Hang up via your phone/softphone
3. Take a message if needed (see next section)

---

## 6. Taking a Message

After most calls, you'll need to record what the caller said and deliver it to the client's contacts.

### Creating a Message

1. On the Dashboard or Messages tab, click **+ New Message**
2. Or use the **screenpop** — click **Take Message** in the client panel

### Message Form Fields

| Field | Description |
|-------|-------------|
| **Client** | The business this message is for (auto-filled from screenpop) |
| **Caller Name** | Full name of the person who called |
| **Caller Phone** | Their callback number |
| **Subject** | Brief one-line summary (e.g. "Appointment request") |
| **Message Body** | Full details of the message |
| **Priority** | Normal / Urgent / Emergency |
| **Delivery Method** | How to send the message (email, SMS, in-app, webhook) |

### Canned Responses

For common message types, use canned responses to save time:
1. In the message body, click **Canned Responses** (or type `/` and start typing)
2. Select the appropriate template
3. Edit it to match the specific caller details

### Submitting the Message

1. Review all fields for accuracy
2. Click **Send Message**
3. The system delivers the message to the client's contacts immediately
4. A confirmation shows the delivery status for each channel

> **Tip:** Always double-check the phone number and spelling of names before sending. These are the most common errors.

---

## 7. Managing Messages

### Viewing All Messages

1. Click **Messages** in the top navigation
2. Messages are listed with status indicators:
   - **Unread** — new, not yet viewed by a contact
   - **Read** — viewed by a contact
   - **Acknowledged** — contact has confirmed they received it
   - **Escalated** — SLA threshold exceeded, supervisor alerted

### Filtering Messages

Use the filter bar to find messages by:
- Client name
- Date range
- Status (unread/read/acknowledged)
- Priority (normal/urgent/emergency)
- Your own messages (click **Mine**)

### Acknowledging a Message

If a client contact calls back to say they received the message:
1. Find the message in the list
2. Click **Acknowledge**
3. Optionally add a note

### Message Delivery Status

Click any message to see the delivery log — it shows each delivery attempt:
- ✅ Delivered successfully
- ❌ Failed (with error reason)
- ⏳ Pending (in queue)

---

## 8. Client Information (Screenpop)

When you answer a call, the screenpop automatically shows the client's profile. You can also access it manually:

1. Go to **Calls** tab
2. Click any call to see the client screenpop

### Screenpop Sections

| Tab | Contents |
|-----|----------|
| **Overview** | Business name, greeting script, instructions, last message |
| **Contacts** | People to notify, their phone numbers and preferences |
| **On-Call** | Who is currently on-call for urgent matters |
| **Appointments** | Upcoming booked appointments |
| **Notes** | Permanent notes about this client (set by admin) |

### Understanding the Greeting Script

The greeting script tells you exactly how to answer calls for each client. Follow it precisely — clients pay for a consistent, branded experience.

Example greeting script:
```
"Good [morning/afternoon], Dr. Johnson's dental practice, [Your Name] speaking, how can I help?"
```

### Special Instructions

Always check the Special Instructions section in the screenpop. It may include:
- Emergency contact procedures
- Out-of-hours handling instructions
- Specific dos and don'ts for this client

---

## 9. Contacts & On-Call Schedules

### Viewing Contacts

1. Click **Contacts** in the top navigation
2. Search by client or contact name
3. View phone numbers, email addresses, and notification preferences

### On-Call Schedules

For clients with on-call contacts (e.g. medical or emergency services):
1. In the screenpop, click the **On-Call** tab
2. The system shows who is currently on-call based on the schedule
3. If the message is urgent, call the on-call person directly

---

## 10. Appointments & Calendar

### Booking an Appointment

1. Click **Appointments** in the navigation
2. Click **+ New Appointment**
3. Select the client
4. Fill in:
   - Caller name and contact number
   - Appointment date and time
   - Service type / reason
   - Notes
5. Click **Book**

The system:
- Checks availability against the client's calendar
- Sends a confirmation to the caller (if email provided)
- Sends a notification to the client's contacts

### Viewing the Calendar

1. Click **Appointments**
2. Use the **Calendar** view or **List** view
3. Filter by client or date range

### Cancelling / Rescheduling

1. Find the appointment in the list
2. Click the appointment
3. Click **Cancel** or **Edit** to reschedule
4. The system sends updated notifications automatically

---

## 11. Tasks

Tasks are to-do items assigned to you by supervisors or created by yourself.

### Viewing Your Tasks

1. Click **Tasks** in the navigation
2. Your open tasks are listed with priority and due date

### Creating a Task

1. Click **+ New Task**
2. Enter a description and due date
3. Set priority: Low / Normal / High / Urgent
4. Click **Save**

### Completing a Task

1. Find the task in your list
2. Click **Mark Complete**
3. Add a completion note if needed

---

## 12. Canned Responses

Canned responses are pre-written message templates that speed up common message types.

### Using a Canned Response

1. When writing a message, click **Canned Responses**
2. Browse or search for the right template
3. Click it to insert it into the message body
4. Edit the placeholder text (shown in [brackets]) with the specific details

### Viewing Available Templates

Templates are created by supervisors and admins. Contact your supervisor to request new templates or changes to existing ones.

---

## 13. Viewing Your Time & Performance

You can view your own performance data without asking a supervisor.

### My Time Today

Click your status button → **⏰ My Time Today**

This shows:
- Bar chart of time in each status code
- Table with hours and minutes per status
- Percentage of your time in each status

**Why this matters:** You're expected to spend the majority of your shift in "Available" status. If you see you've spent a lot of time in non-available statuses, consider whether that's appropriate.

### Time Report (Weekly/Monthly/Yearly)

In the same panel, click the period tabs:
- **Today** — current shift
- **Week** — Monday to Sunday
- **Month** — calendar month
- **Year** — rolling 365 days

### Call Statistics

Your supervisor can see (and you can discuss):
- Number of calls handled
- Average handle time
- Messages taken
- QA score average

---

## 14. Real-Time Wallboard

The wallboard shows live statistics across the whole team. If you have a spare monitor, keeping the wallboard open is good practice.

To access: Go to `https://[your-url]/wallboard` in a browser (no login required, display-only).

The wallboard shows:
- Total calls in queue
- Active operators and their status
- Calls handled today
- Messages sent today
- SLA compliance rate

---

## 15. QA Scores & Feedback

Your supervisor or admin may score your calls for quality assurance.

### Viewing Your QA Scores

1. Click your profile menu (top-right) → **My Performance**
2. QA scores are listed by date with notes from the reviewer
3. Each score covers: greeting quality, accuracy, professionalism, message completeness

### Acting on Feedback

If you receive a low QA score:
1. Read the reviewer's notes
2. If unclear, discuss with your supervisor
3. Work on the areas flagged — scores improve with practice

---

## 16. Notifications & Alerts

### In-App Notifications

Real-time alerts appear in the top-right bell icon. Click it to see:
- New incoming calls
- Urgent messages
- Task reminders
- Noticeboard announcements

### Browser Push Notifications

If your browser asks permission to show notifications, click **Allow**. This enables alerts even when the browser tab is in the background.

### Escalation Alerts

If a message is not acknowledged within the client's SLA time:
- The system escalates to the next contact on the list
- Your supervisor receives an alert
- The message is flagged as **Escalated** in the message list

---

## 17. Account Settings

Click your name/avatar in the top-right corner → **Settings**

### Changing Your Password

1. Go to Settings → **Change Password**
2. Enter your current password
3. Enter and confirm your new password
4. Click **Save**

Password requirements:
- Minimum 12 characters
- At least one uppercase letter (A–Z)
- At least one lowercase letter (a–z)
- At least one number (0–9)
- At least one special character (`!@#$%^&*` etc.)

### Updating Your Profile

Settings → **Profile**:
- Update your display name
- Update your email address (used for password resets)
- Change your extension number (confirm with admin before changing)

---

## 18. Two-Factor Authentication (TOTP)

Two-factor authentication adds a second layer of security. When enabled, you need both your password AND a 6-digit code from your phone.

### Setting Up TOTP

1. Install an authenticator app on your phone:
   - **Google Authenticator** (iOS/Android)
   - **Authy** (iOS/Android)
   - **Microsoft Authenticator** (iOS/Android)

2. In the operator console, go to Settings → **Security** → **Set Up Two-Factor Auth**
3. A QR code appears on screen
4. Open your authenticator app → **Add account** → **Scan QR code**
5. Point your camera at the QR code
6. The app adds a "SinglePoint Calls" entry showing a 6-digit code
7. Enter that 6-digit code in the console to confirm setup
8. Click **Enable 2FA**

**Save your backup codes!** You'll receive 10 single-use backup codes. Store them somewhere safe (not on your phone). If you lose access to your authenticator app, these codes let you log in.

### Using TOTP at Login

1. Enter username and password → Sign In
2. When prompted for your TOTP code, open your authenticator app
3. Find the SinglePoint Calls entry — enter the 6-digit code shown
4. Codes change every 30 seconds, so enter it quickly
5. Click **Verify**

### If You Lose Access to Your Authenticator App

1. Use one of your saved backup codes to log in
2. Once in, go to Settings → Security → **Reset Two-Factor Auth**
3. Or contact your administrator to reset it for you

---

## 19. Tips for Excellent Service

### Call Handling

- **Answer within 3 rings** — callers form an impression within seconds
- **Smile when you speak** — it genuinely makes your voice sound warmer
- **Repeat back key details** — "So that's a callback for Mr. Smith at 07700 900123 — is that correct?"
- **Never put a caller on hold for more than 60 seconds** without checking back in
- **If you don't know, say so** — "I'll make sure [Client Name] receives this message" is better than guessing

### Message Accuracy

- **Spell out names** — "Is that C-H-R-I-S T-H-O-M-P-S-O-N?"
- **Read back phone numbers** — always confirm before ending the call
- **Mark urgency correctly** — don't mark everything urgent, but don't miss genuine emergencies
- **Add context** — "Caller was distressed" or "Caller mentioned this is time-sensitive" helps the client prioritise

### Status Management

- **Set status accurately at all times** — routing depends on it
- **Break is short** — if you're going to be away more than 15 minutes, discuss with your supervisor
- **Return promptly** — check the wallboard when returning from break to see if calls are queuing

### Professionalism

- **Never discuss one client with another caller**
- **Never share a client's information** verbally unless the caller is verified
- **Follow the screenpop instructions exactly** — clients have specific reasons for their instructions
- **If a caller is abusive** — you may calmly warn them once, then end the call and inform your supervisor

---

## 20. Common Questions (FAQ)

**Q: A call came in but I didn't see it — what happened?**  
A: Check your status was set to "Available". Calls only route to available operators. If you were on Available and missed it, check the Dashboard — the call may have been answered by a colleague.

**Q: I sent a message but the client says they didn't receive it.**  
A: Go to Messages, find the message, click it, and check the Delivery Log. It shows whether each channel succeeded or failed with the error reason. Report this to your supervisor with the delivery log details.

**Q: How do I know who to notify for urgent calls?**  
A: Check the screenpop's **On-Call** tab. It shows who is currently on duty for this client. For emergencies, follow the Special Instructions — they specify the escalation procedure.

**Q: What if I accidentally take a message for the wrong client?**  
A: Inform your supervisor immediately. They can edit the message to assign it to the correct client and re-send the notifications.

**Q: The caller wants to speak to someone directly — what do I do?**  
A: Check the screenpop for transfer instructions. Most clients prefer messages rather than call transfers — if uncertain, take a message and let the client decide whether to call back.

**Q: My phone extension isn't ringing when I click Answer.**  
A: Your SIP softphone may be disconnected. Check your softphone application is running and registered. If the problem persists, contact your administrator.

**Q: How do I report a problem with the system?**  
A: Tell your supervisor with as much detail as possible: what you were doing, what happened, any error message you saw, and the approximate time. They will escalate to the system administrator.

**Q: Can I see messages from previous days?**  
A: Yes — go to Messages, use the date range filter to search any historical period.

**Q: What do I do if the system is unavailable?**  
A: Follow your offline emergency procedure (provided by your supervisor). Typically this involves a paper-based message form or a backup phone system.

---

*Thank you for being part of the SinglePoint Calls team. Your professionalism makes the difference for every business we serve.*

*For system support, contact your administrator. For HR or operational questions, contact your supervisor.*
