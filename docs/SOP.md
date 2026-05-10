# Standard Operating Procedure
## SinglePoint Calls — 24/7 Telephone Answering Service

| Document Reference | SPC-SOP-001 |
|---|---|
| Version | 1.0 |
| Effective Date | 10 May 2026 |
| Review Date | 10 May 2027 |
| Owner | Operations Manager |
| Applies To | All Operators, Supervisors, and Administrators |

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Staff Roles and Responsibilities](#2-staff-roles-and-responsibilities)
3. [Call Handling Procedures](#3-call-handling-procedures)
4. [Status Code Usage Policy](#4-status-code-usage-policy)
5. [Message Handling](#5-message-handling)
6. [Break and Shift Management](#6-break-and-shift-management)
7. [Client Management Procedures](#7-client-management-procedures)
8. [Escalation Procedures](#8-escalation-procedures)
9. [Quality Assurance](#9-quality-assurance)
10. [Data Protection and GDPR Compliance](#10-data-protection-and-gdpr-compliance)
11. [Incident Reporting](#11-incident-reporting)
12. [System Outage Procedures](#12-system-outage-procedures)

---

## 1. Purpose and Scope

### 1.1 Purpose

This Standard Operating Procedure (SOP) defines the policies, responsibilities, and step-by-step procedures for all staff operating the SinglePoint Calls 24/7 Telephone Answering Service platform. It ensures consistent, professional, and compliant service delivery across all shifts.

### 1.2 Scope

This SOP applies to:

- All operators handling inbound calls on behalf of client businesses
- Supervisors overseeing call operations and quality
- Administrators managing platform configuration and client accounts
- Any temporary, part-time, or contracted staff accessing the operator console

### 1.3 Platform Overview

SinglePoint Calls is a telephone answering service platform comprising:

- **Operator Console** (`index.html`) — the primary web application used by operators and supervisors to answer calls, take messages, and manage client interactions in real time
- **Client Portal** (`portal.html`) — a self-service web application allowing client businesses to view their messages, manage contacts, update on-call rosters, and access call logs
- **Asterisk/FreePBX** — the telephony backend that routes inbound calls via Direct Inward Dialling (DID) numbers through the ARI (Asterisk REST Interface) to the operator console

All operator actions are recorded in an immutable audit log. All staff must read and adhere to this SOP before handling live calls.

---

## 2. Staff Roles and Responsibilities

### 2.1 Role Definitions

The platform has three distinct roles. Access permissions are enforced by the system and cannot be overridden by individual operators.

#### 2.1.1 Operator

The front-line role responsible for answering calls and delivering excellent customer service on behalf of client businesses.

**Responsibilities:**
- Answer all inbound calls promptly (within the client's SLA target, typically 30 seconds)
- Take accurate, complete messages using the message form
- Maintain correct status codes at all times
- Follow client-specific call scripts and instructions
- Escalate calls as required by client rules
- Acknowledge messages once clients confirm receipt
- Complete post-call message forms without delay
- Report technical issues or concerns to the supervisor on duty

**System access:** Operator console; own shift and break records; own status time report; message creation and viewing

#### 2.1.2 Supervisor

Responsible for real-time operational oversight, quality monitoring, and shift management.

**Responsibilities:**
- Monitor all operator statuses on the wallboard in real time
- Ensure adequate staffing across the shift
- Approve or adjust break schedules to maintain cover
- Perform live call monitoring where quality concerns arise
- Review and action escalated messages within defined timeframes
- Conduct regular QA scoring of operator calls
- Approve time-off requests
- Manage client availability status (open/closed/out of hours)
- Brief operators at shift handover
- Complete shift incident reports

**System access:** All operator-level access, plus operator monitoring, QA scoring, shift management, client availability controls, and reporting dashboards

#### 2.1.3 Administrator

Responsible for platform configuration, client account management, and system governance.

**Responsibilities:**
- Create, modify, and deactivate operator accounts
- Configure client accounts, DIDs, delivery settings, and IVR flows
- Manage the Do Not Call (DNC) list
- Configure client escalation rules and SLA thresholds
- Run and schedule reports
- Review the operator audit log
- Manage system settings including token lifetimes and company name
- Oversee GDPR data retention settings
- Investigate and resolve incidents flagged by supervisors
- Ensure compliance with this SOP through regular review

**System access:** Full platform access including all admin panels, audit log, system settings, and GDPR deletion records

### 2.2 Accountability

All staff are personally accountable for:
- Maintaining the confidentiality of all caller and client information
- Accurate and timely completion of call records
- Compliance with UK data protection law (UK GDPR / Data Protection Act 2018)
- Adherence to this SOP at all times

Failure to comply may result in disciplinary action and, where applicable, referral to the Information Commissioner's Office (ICO).

---

## 3. Call Handling Procedures

### 3.1 Pre-Shift Preparation

Before going ready for calls, operators must:

1. Log in to the Operator Console using their unique username and password
2. Complete two-factor authentication (2FA) if prompted
3. Ensure their SIP extension is registered and audio is functioning (use Settings > Audio Test)
4. Review any client notices or updated scripts (visible in the client information panel)
5. Read any noticeboard messages posted by supervisors
6. Set status to **Ready**

Do not set status to Ready if audio or telephony connectivity is in doubt. Notify the supervisor immediately.

### 3.2 Answering Inbound Calls

#### 3.2.1 Call Arrival

When a call arrives, the console displays a call notification showing:

- The caller's number and name (if CLI is available)
- The client business the call is for (matched by DID)
- A **VIP** badge if the caller's number is on the client's VIP list
- An **Ignore** option if the call has been pre-screened by IVR

The operator's status badge changes to **RINGING** automatically.

#### 3.2.2 Answering Procedure

1. Click **Answer** in the operator console. The console bridges the inbound channel to the operator's SIP extension.
2. Status changes to **ON CALL** automatically.
3. Greet the caller using the client's specified greeting script. If no script is provided, use the default greeting:
   > *"Good [morning/afternoon/evening], [Client Business Name], you're through to [Operator Name] speaking, how can I help you?"*
4. Open the client's script or information sheet from the console sidebar for reference.
5. Collect all required information as specified in the client's call script or custom form.

#### 3.2.3 Caller Identification

- Always verify the caller's name and, where required by the client, their callback number.
- If the caller's number matches the client's VIP list, note this and prioritise the call accordingly (see Section 8.3).
- If the caller's number is on the DNC list, the call is automatically rejected by the system before it reaches the operator queue. No action is required.

#### 3.2.4 Placing a Caller on Hold

When it is necessary to consult information or refer to a supervisor:

1. Click **Hold** in the call controls. The caller is placed on music-on-hold.
2. Inform the caller before placing them on hold:
   > *"I just need to check that for you — would you mind holding for a moment? Thank you."*
3. Retrieve the information or speak to the supervisor.
4. Click **Unhold** to resume the call. Do not leave a caller on hold for more than 90 seconds without returning to update them.
5. If the query cannot be resolved quickly, offer a callback rather than an extended hold.

#### 3.2.5 Call Transfer

Transfers are used when the caller must speak directly with someone at the client business.

**Cold transfer (blind):**
1. Advise the caller they are being connected:
   > *"I'll transfer you through now — please hold the line."*
2. Enter the destination extension in the Transfer field and click **Transfer**.
3. Complete the message form after the transfer completes.

**Warm transfer (supervised):**
1. Place the caller on hold.
2. Dial the destination party using your own SIP handset or softphone.
3. Brief the destination party on the caller's query.
4. Transfer the caller only when the destination party is ready.
5. Complete the message form if the transfer was not answered.

Transfers to external numbers must be authorised by a supervisor unless the client's script explicitly permits them.

#### 3.2.6 Post-Call Message Requirement

After every call, operators are required to complete a message before returning to Ready. The message form pre-populates with the caller's details and the client associated with the call. The operator cannot return to Ready until the message form is submitted.

If the call required no message (e.g. a simple information query the operator resolved), select the appropriate call type from the form and submit with a brief note.

#### 3.2.7 Call Wrap-Up

After submitting the message form:
- The status returns to **Ready** automatically.
- Review the sent message confirmation to ensure delivery has been initiated.
- If delivery shows as failed for a required channel (email, SMS), notify the supervisor immediately.

### 3.3 Outbound Calls

Where a client requires outbound calls (e.g. patch-through attempts or callback fulfilment):

1. Confirm with the supervisor that outbound calling is permitted for this client.
2. Use the Originate function in the console, or your SIP handset, to dial the number.
3. Record the outcome in the relevant message or callback record.
4. All outbound calls are subject to the same post-call message requirements.

### 3.4 Voicemail

If the operator console indicates a voicemail has been left (displayed in the Voicemail panel):

1. Listen to the voicemail in full.
2. Create a message record with the voicemail content, caller details, and a transcription (if the auto-transcription service is active).
3. Mark the voicemail as handled once the message has been sent.

---

## 4. Status Code Usage Policy

### 4.1 Overview

Accurate status codes are essential for workforce planning, client SLA compliance, and payroll verification. All time spent in each status is recorded and can be viewed by the operator (today / week / month / year), by supervisors, and by administrators.

**Status codes must reflect the operator's actual activity at all times.** Misrepresenting availability (e.g. sitting idle on Ready without being available to take calls, or remaining on a break code after returning to the desk) is a disciplinary matter.

### 4.2 Status Definitions and Permitted Use

| Status Code | Label | When to Use | Time Limit |
|---|---|---|---|
| `ready` | Ready | Actively available to receive inbound calls. Operator is at their workstation, headset on, console open. | No limit. This is the normal working state. |
| `busy` | On Call | Set automatically when a call is answered; cleared automatically when the call ends. Operators must not manually change this status. | Duration of active call. System-managed. |
| `break` | Short Break | Brief comfort stop between calls. Must not be used during active periods without supervisor approval. | Maximum 15 minutes. |
| `comfort` | Comfort Break | Toilet or personal comfort break during a call period. Shorter and less predictable than a scheduled break. | Maximum 10 minutes. |
| `lunch` | Lunch | Main meal break as per shift schedule. Scheduled by supervisors; only use at the approved time. | As per shift schedule, typically 30–60 minutes. |
| `training` | Training | Attending or completing training sessions, including product briefings, call script reviews, or online learning. Requires supervisor prior approval. | Duration of scheduled training. |
| `meeting` | Meeting | Team meetings, briefings, one-to-ones, or client-specific briefing sessions. Requires supervisor prior approval. | Duration of scheduled meeting. |
| `admin` | Admin Work | Non-call administrative tasks: updating contact records, completing compliance documentation, processing time-off requests. Requires supervisor prior approval. | As agreed with supervisor. |
| `offline` | Offline | End of shift or disconnection. Set this status before logging out to ensure accurate time reporting. | N/A. |

### 4.3 Status Change Procedure

1. Click the status badge at the top of the console.
2. Select the appropriate status from the dropdown menu.
3. For break statuses, the system prompts for a break type; select the correct one.
4. The system records the precise time the status change took effect.

Supervisors are notified of status changes in real time via the wallboard.

### 4.4 Extended Non-Ready Periods

If an operator needs to remain in a non-Ready status beyond the time limits above:

1. Notify the supervisor before the time limit expires.
2. The supervisor will either approve an extension or direct the operator to return to Ready.
3. Supervisors may update an operator's status directly if the operator is unreachable.

### 4.5 Status at Shift End

Before logging out:
1. Ensure all pending messages are submitted and delivery confirmed.
2. Set status to **Offline**.
3. Log out of the operator console.
4. Confirm with the incoming shift supervisor that handover is complete.

---

## 5. Message Handling

### 5.1 Message Creation

Messages are created in the post-call message form, which pre-populates with caller details from the inbound call. Complete every field relevant to the client's requirements:

| Field | Requirement |
|---|---|
| Client | Pre-filled from the call routing. Do not change unless an error occurred. |
| Caller Name | Full name as provided by the caller. Do not abbreviate. |
| Caller Phone | Verified callback number. Confirm with the caller if CLI is unavailable or differs. |
| Caller Company | Complete if the caller represents a business. |
| Subject | A clear, concise one-line summary of the caller's query or purpose. |
| Message Body | Full detail of the caller's message, written in reported speech. Include all key information the client will need. |
| Urgency | See Section 5.2. |
| Call Type | Select from: General Enquiry, Appointment, Callback Request, Complaint, Emergency, or as specified by the client. |

Where a client has a custom form (additional fields configured for their account), all mandatory fields must be completed before the message can be submitted.

### 5.2 Urgency Classification

| Urgency Level | Description | Examples |
|---|---|---|
| Normal | Routine calls requiring a response within the client's standard SLA. | General enquiries, appointment requests, non-time-sensitive messages. |
| Urgent | Calls requiring a prompt response, sooner than the standard SLA. | Time-sensitive deliveries, urgent booking requests, chasing critical decisions. |
| Emergency | Calls involving immediate risk to life, safety, or property. | Medical emergencies, fire, floods, safeguarding concerns, gas leaks. |

The AI classification system may automatically upgrade a message from Normal to Urgent if it detects high-confidence urgency indicators in the message body. Operators should not rely on this and must set the appropriate urgency manually when it is evident from the call.

Emergency messages must be escalated immediately — see Section 8.1.

### 5.3 Message Delivery

On submission, the system fans out the message to all enabled delivery channels for that client. Standard channels include:

- **Email** — sent to the client's configured contacts, subject to each contact's `notify_email` flag
- **SMS** — sent via Twilio to contacts with `notify_sms` enabled, where the client's SMS delivery action is active
- **WhatsApp** — sent via the WhatsApp Business Cloud API to contacts with `notify_whatsapp` enabled
- **In-app** — always stored and visible in the client portal regardless of other delivery settings
- **Webhook** — HTTP POST to any registered client webhook endpoints
- **Slack / Microsoft Teams** — delivered to configured workspace webhooks where configured

The message delivery status (sent / failed) is visible in the message record. If any external channel (email, SMS, webhook) reports a failure, the operator must notify the supervisor.

If the client has auto-reply enabled, the system automatically sends a receipt acknowledgement to the caller's email address where it is known.

### 5.4 Canned Responses and Scripts

The console provides access to:

- **Canned Responses** — pre-written message body templates for common call types. Accessible via the shortcode lookup in the message form. Always personalise canned responses before sending.
- **Call Scripts** — client-specific scripts stored in the client information panel. Follow the script precisely; do not deviate without supervisor approval.
- **Knowledge Base** — a searchable knowledge base accessible within the console for reference during calls.

### 5.5 Message Acknowledgement

Clients acknowledge messages via a unique acknowledgement link included in delivery emails, or through the client portal. When a message is acknowledged:

- The message status updates to **Acknowledged** in the console.
- Operators and supervisors can see the acknowledgement in real time.

Operators do not need to take action on acknowledgement unless a client contacts the service to confirm or query a message. In such cases, refer the call to a supervisor.

### 5.6 Broadcast Messages

Supervisors and administrators may send broadcast messages to all contacts for a client simultaneously (e.g. service notifications, emergency alerts). This function is accessible to supervisors and above only.

### 5.7 Message Archiving

Messages are archived (not deleted) after the client's configured retention period has elapsed. Archived messages are not visible to portal users but remain available to administrators for audit purposes until the GDPR retention purge runs. See Section 10 for retention rules.

---

## 6. Break and Shift Management

### 6.1 Shift Scheduling

Shifts are managed by supervisors and administrators in the Shift Planner within the admin panel. Operators can view their own upcoming shifts from the console.

Shift types are:
- **Regular** — standard operational shift
- **On-call** — standby shift; operator is contactable and available to handle calls but not continuously logged in
- **Training** — scheduled training session; no inbound call handling expected

### 6.2 Break Scheduling

Supervisors are responsible for planning breaks to ensure continuous call coverage. The minimum staffing requirement to release an operator for a break is defined by the current call volume and is at the supervisor's discretion.

**Operators must not self-authorise breaks.** Request a break from the supervisor before changing status. The supervisor will advise the appropriate time.

### 6.3 Break Rules Summary

- A maximum of two short breaks (15 minutes each) per standard 8-hour shift, plus a 30–60 minute meal break
- Comfort breaks are in addition to scheduled breaks and do not require advance notice, but must be kept brief
- Training and admin status require supervisor pre-approval and are planned in advance
- Meeting status is set by the supervisor or the operator when attending a formally scheduled meeting

### 6.4 Shift Handover

At the end of each shift, the outgoing operator or supervisor must:

1. Ensure all calls have concluded or been handed to a colleague
2. Confirm all pending messages have been submitted and delivery is confirmed
3. Brief the incoming shift on any outstanding actions, client notes, or escalations
4. Record any incidents in the incident log (see Section 11)
5. Set status to Offline and log out

The incoming supervisor must confirm adequate staffing and that all positions are covered before the outgoing supervisor departs.

### 6.5 Time-Off Requests

Operators submit time-off requests through the console (Shifts section). Requests are reviewed and approved or denied by supervisors. Operators should submit requests as far in advance as possible, and at least 72 hours before the intended absence for routine requests.

---

## 7. Client Management Procedures

### 7.1 Client Account Overview

Each client account contains:

- Business name and contact details
- One or more DID numbers that route calls to the service
- Opening times and timezone configuration (used to determine business hours)
- Delivery actions (which channels to use for message delivery)
- Escalation rules and SLA targets
- VIP caller list
- Custom call scripts and forms
- IVR flow configuration (where pre-screening is enabled)
- Data retention period
- SMTP credentials (if the client uses their own email domain for delivery)

Client accounts are created and maintained by administrators.

### 7.2 Client Availability Status

Supervisors can set a client's availability status, which affects how the console presents information to operators and what information is displayed in the client portal:

| Status | Meaning |
|---|---|
| Available | Client is open and operating normally. |
| Out of Office | Client is temporarily unavailable (e.g. holiday closure). |
| Annual Leave | Client staff are on leave. |
| In a Meeting | Client is in a meeting; take messages only. |
| Closed — Outside Business Hours | Set automatically based on the client's opening times configuration. |

When a client is outside business hours, the system indicates this to operators. All calls during out-of-hours periods are handled as message-taking; do not attempt to transfer calls to client staff unless the client's out-of-hours script explicitly authorises it.

### 7.3 Client Opening Times

Each client has configurable opening hours by day of the week, including timezone support. These are used by the system to determine whether the client is currently open. An empty opening times configuration means the client is considered always open.

Operators should check the client's opening times in the console before advising callers about the client's availability.

### 7.4 Contact Management

Client contacts are the individuals who receive message deliveries. Operators do not typically manage contacts directly; this is handled by supervisors or administrators, or by the client via the portal.

Key contact properties:
- Name, phone, and email
- Notification preferences (email, SMS, phone, WhatsApp) per contact
- Priority — determines escalation order
- On-call flag — marks which contact is currently the primary on-call recipient
- On-call schedule — time-based on-call rotation configured by supervisors or the client

Where a caller asks for a specific contact, check the contact list in the client panel and advise whether the contact is currently on call. Never give out personal contact details from the system unless the client's script explicitly authorises this.

### 7.5 VIP Callers

VIP numbers are configured per client. When a VIP caller rings:
- A VIP badge is displayed prominently on the call notification
- Answer the call in preference to non-VIP calls where possible
- Handle with additional care; refer to any VIP-specific instructions in the client script
- Log the VIP interaction as normal; the system records the VIP flag automatically

### 7.6 IVR Flows

Some clients have IVR (Interactive Voice Response) flows configured to pre-screen calls before they reach the operator queue. The IVR may:

- Play a greeting and route the caller based on their keypad selection
- Collect information such as account numbers before transfer to an operator
- Handle simple out-of-hours announcements without operator involvement

Operators do not configure IVR flows. Configuration is performed by administrators using the IVR builder. If a client reports that their IVR is not functioning correctly, escalate to an administrator immediately.

### 7.7 Do Not Call (DNC) List

The DNC list is a platform-wide list of numbers from which calls are automatically rejected before reaching the operator queue. Numbers may be added to the DNC list by administrators following:

- A caller's explicit request to be removed from all contact
- Legal or compliance instructions
- Client instructions

When a DNC-blocked call attempt occurs, the console displays a toast notification. No operator action is required. If a caller contacts the service to complain about being blocked, take their details, log a message, and escalate to a supervisor.

Operators must never add or remove numbers from the DNC list. Requests must be escalated to a supervisor and processed by an administrator.

### 7.8 Client Portal

The Client Portal is a separate, self-service web application for client businesses. Portal users can:

- View their messages and call logs
- Acknowledge messages
- Update their contact details and on-call flags
- Raise appointments and callbacks
- Access files and documentation shared by the service

Portal access is managed entirely by administrators. Operators should direct client enquiries about portal access to a supervisor.

---

## 8. Escalation Procedures

### 8.1 Emergency Calls

An emergency call is any call involving immediate risk to life, personal safety, property, or where the caller requests emergency services.

**Immediate actions:**
1. Remain calm and reassure the caller.
2. If the caller needs emergency services, advise them to call **999** (or **112**) immediately. If they cannot do so themselves, offer to stay on the line and dial 999 on their behalf using a separate line.
3. Create a message with urgency set to **Emergency**.
4. Immediately notify the supervisor on duty by any available means (console chat, verbal, instant message).
5. Follow the client's emergency script if one exists; otherwise follow this procedure.
6. Do not end the call until the caller is safe or has been connected to emergency services.
7. Record a full account of the call in the message body, including everything said and any actions taken.

Emergency messages trigger immediate delivery to all enabled channels for the client regardless of standard SLA rules.

### 8.2 Escalation via Escalation Rules

Each client can configure time-based escalation rules. The escalation service checks every two minutes for unacknowledged messages that have exceeded the client's escalation threshold. When the threshold is breached:

- The system automatically re-delivers the message to the next-priority contact(s) as configured in the escalation rules.
- The message is flagged as escalated in the console.
- Supervisors are notified.

Operators do not trigger automatic escalation manually. However, if an operator believes a message requires escalation before the automated threshold is reached (e.g. the caller reports the situation has worsened), they must notify the supervisor, who can trigger manual escalation.

### 8.3 VIP Caller Escalation

When a VIP caller is on the line and cannot be handled by standard message-taking:

1. Place the caller on hold.
2. Notify the supervisor immediately.
3. The supervisor will assess whether a warm transfer or direct contact with the client is appropriate.
4. Do not keep a VIP caller on hold for more than 60 seconds without returning to update them.

### 8.4 Out-of-Hours Escalation

Outside the client's configured opening hours:

1. Follow the client's out-of-hours script.
2. If the script specifies an on-call contact, deliver the message to that contact per the on-call schedule.
3. If the caller reports an emergency, follow Section 8.1 regardless of business hours.
4. Never attempt to transfer a caller outside business hours unless the client's script explicitly authorises out-of-hours transfers.

### 8.5 Complaint Calls

If a caller makes a complaint:

1. Listen without interruption and apologise for the inconvenience.
2. Do not acknowledge fault on behalf of the client or the service.
3. Take a detailed message, selecting **Complaint** as the call type and setting urgency to **Urgent**.
4. Notify the supervisor before ending the call if the complaint is severe.
5. Do not attempt to resolve the complaint on behalf of the client; pass the message and let the client respond.

### 8.6 Supervisor Escalation Triggers

Operators must immediately notify the supervisor in any of the following situations:

- A caller is distressed, threatening, or abusive
- A caller discloses a safeguarding concern (child or adult at risk)
- An emergency call or potential emergency
- A system error prevents a call from being answered or a message from being sent
- A delivery failure is reported for an emergency or urgent message
- A caller disputes information given by a previous operator
- Any call where the operator is uncertain how to proceed

---

## 9. Quality Assurance

### 9.1 QA Framework

All calls are subject to quality assurance monitoring. The QA programme is managed by supervisors and administrators using the QA scoring system built into the platform.

### 9.2 QA Scoring

Supervisors score calls against a structured scorecard. Key assessment criteria include:

- **Greeting** — correct greeting script used; professional and warm tone
- **Caller Identification** — caller name and callback number verified accurately
- **Information Gathering** — all required fields collected; questions asked clearly and without ambiguity
- **Message Accuracy** — message body accurately reflects the caller's communication; no errors or omissions
- **Urgency Classification** — urgency level correctly applied
- **Hold Procedure** — caller advised before hold; no excessive hold times
- **Closing** — call closed politely; caller has nothing further; call ended cleanly
- **Wrap-Up Speed** — message submitted promptly after call

QA scores are stored against the specific call log and are visible to supervisors and administrators. Operators can request to view their own scores.

### 9.3 Monitoring and Coaching

- Supervisors conduct live call monitoring without interrupting the call where quality concerns arise.
- QA scores below the target threshold (defined by the Operations Manager) trigger a mandatory coaching session.
- All coaching sessions are recorded in the operator's personnel record.
- Call recordings (where enabled) are available in the call log for review within the operator console.

### 9.4 CSAT (Customer Satisfaction) Surveys

Where a client has CSAT surveys enabled, the system automatically sends a satisfaction survey to the caller via SMS after the call concludes. Ratings are on a scale of 1–5. Results are visible to supervisors and administrators in the CSAT dashboard.

CSAT results are reviewed in monthly performance reviews. Consistently low scores are investigated and addressed through additional coaching or process changes.

### 9.5 Performance Reviews

Performance reviews are conducted monthly and consider:
- QA scores (average and trend)
- CSAT survey results
- Status time analysis (Ready vs. non-Ready ratio)
- Call volume handled
- Message accuracy (error rate)
- Attendance and punctuality

### 9.6 Leaderboard

The wallboard and leaderboard display real-time and periodic performance data including calls handled, messages sent, and QA scores. This is for operational awareness and should be used constructively. Supervisors should ensure the leaderboard is used to motivate rather than to pressurise staff.

---

## 10. Data Protection and GDPR Compliance

### 10.1 Legal Basis

SinglePoint Calls processes personal data on behalf of its client businesses. The company acts as a **data processor** in relation to call and message data, and as a **data controller** in relation to operator data and internal platform records.

Processing is conducted under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.

### 10.2 Categories of Personal Data Processed

| Category | Data Elements | Retention |
|---|---|---|
| Caller data | Name, phone number, email, company, message content | Configured per client (default 12 months) |
| Call logs | Caller ID, call timestamps, recording URL, disposition | Configured per client (default 12 months) |
| Operator data | Name, email, username, login history, status records, break records | Internal operational records; separate DSAR process |
| Client contact data | Name, phone, email, notification preferences | Until contact is deleted by client or at contract end |
| Billing records | Client billing data | 7 years (UK legal requirement) |

### 10.3 Data Retention and Automatic Purging

The system automatically purges caller and call data when the configured retention period expires. Every purge is logged in the `data_deletion_log` table (recording client, table, records deleted, and cut-off date) to satisfy UK GDPR Article 30 (records of processing) and Article 17 (right to erasure / storage limitation).

Retention periods are configured per client by administrators. The default retention period is 12 months.

**Operators and supervisors must not:**
- Retain personal data outside the platform (e.g. in personal notes, spreadsheets, or email)
- Export or download personal data unless specifically authorised and logged
- Share caller or client data with any third party not involved in service delivery

### 10.4 Data Subject Access Requests (DSARs)

If a caller or client contact requests a copy of their personal data (a Subject Access Request):

1. Note the name and contact details of the individual making the request.
2. Log a message against the appropriate client account, flagging it as a DSAR.
3. Escalate to a supervisor immediately.
4. Do not attempt to fulfil the DSAR without authorisation from the administrator or Data Protection Officer.

DSARs must be responded to within 30 calendar days under UK GDPR.

### 10.5 Right to Erasure

If a caller requests that their data be deleted:

1. Note the request and the caller's number.
2. Log the request as a message and escalate to a supervisor.
3. If the caller is also requesting to be added to the DNC list, note this separately.
4. The administrator will process the erasure request and log it in the audit trail.

### 10.6 Data Breach Procedure

A personal data breach is any accidental or unlawful destruction, loss, alteration, unauthorised disclosure of, or access to, personal data.

Examples include:
- A message sent to the wrong email address or phone number
- A caller overhearing another caller's details
- Unauthorised access to the operator console
- Loss or theft of a device used to access the console

If a data breach occurs or is suspected:

1. Stop any ongoing breach immediately if it is within your control.
2. Notify the supervisor on duty immediately — do not attempt to investigate or resolve alone.
3. Preserve any relevant information (screenshots, system timestamps, message IDs).
4. The supervisor escalates to the administrator and Operations Manager.
5. If the breach is likely to result in a risk to individuals, it must be reported to the ICO within **72 hours** of becoming aware.

The operator audit log is used to support breach investigations; all actions are timestamped and non-repudiable.

### 10.7 Confidentiality

All information received through the answering service — caller details, message content, client business information — is strictly confidential.

Operators must not:
- Discuss calls or message content outside the platform
- Share client account details or scripts with unauthorised parties
- Leave the console logged in and unattended

All operators must sign and comply with the company's confidentiality agreement.

### 10.8 Two-Factor Authentication

Two-factor authentication (2FA) is available for all operator accounts using TOTP (time-based one-time password) via an authenticator app. 2FA significantly reduces the risk of unauthorised account access. Administrators may mandate 2FA for all operators as a system policy.

If an operator loses access to their authenticator app:
1. They may use a backup code (provided at the time of 2FA enrolment).
2. If no backup codes remain, the operator must contact an administrator to reset their 2FA configuration.

Backup codes must be stored securely. Do not store backup codes in a shared location or unencrypted file.

---

## 11. Incident Reporting

### 11.1 What Constitutes an Incident

An incident is any unplanned event that has caused, or has the potential to cause, harm to:
- A caller (e.g. delayed emergency response, incorrect information given)
- A client business (e.g. missed call, lost message, delivery failure)
- The company (e.g. data breach, system outage, reputational damage)
- An operator (e.g. abusive caller, health and safety concern)

### 11.2 Immediate Actions

1. Ensure the immediate situation is controlled (call ended safely, service restored, etc.).
2. Notify the supervisor on duty without delay.
3. Do not delete, alter, or discuss the incident with other operators before reporting.
4. Preserve all relevant information: call log IDs, message IDs, timestamps, screenshots.

### 11.3 Incident Log

All incidents are logged by the supervisor using the incident log within the operator console. The log must capture:

- Date and time of the incident
- Description of what occurred
- System components or call logs involved (reference IDs)
- Caller or client affected (if applicable)
- Immediate actions taken
- Operator(s) involved
- Whether a data breach is involved

The incident log is reviewed by the Operations Manager at least weekly.

### 11.4 Near Misses

Near misses — events that could have resulted in an incident but did not — must also be reported. Near-miss reporting is encouraged and should be treated as a learning opportunity, not a disciplinary matter.

### 11.5 Abusive Callers

If a caller is abusive (verbally threatening, discriminatory, or harassing):

1. Calmly inform the caller:
   > *"I'm sorry, but I'm unable to continue this call if it continues in this manner. I will need to end the call."*
2. If the behaviour continues, end the call.
3. Log the call immediately; note the caller's number and a factual account of what was said.
4. Notify the supervisor.
5. The supervisor will consider whether the caller's number should be added to the DNC list.

Operators are never required to tolerate abusive or threatening behaviour. Welfare takes priority.

---

## 12. System Outage Procedures

### 12.1 Types of System Failure

| Failure Type | Description | Impact |
|---|---|---|
| Console unavailable | Web application not loading or crashing | Operators cannot see or answer calls |
| Telephony failure | Asterisk/ARI disconnection; SIP failure | Calls not received or cannot be answered |
| Database failure | Database connection errors | Messages cannot be saved or retrieved |
| Delivery failure | Email/SMS/webhook not delivering | Clients not receiving messages |
| Internet outage | Network connectivity lost | Full service disruption |

### 12.2 Telephony / ARI Disconnection

The console displays a connection warning when the ARI WebSocket is disconnected. In this event:

1. Note the time the disconnection occurred.
2. Notify the supervisor immediately.
3. Do not attempt to answer calls until connectivity is restored.
4. The administrator should check the ARI connection status and Asterisk server health.
5. If the outage is expected to last more than five minutes, activate the business continuity procedure.

### 12.3 Business Continuity Procedure

In the event of a prolonged system outage affecting call reception:

1. The supervisor contacts the client businesses affected using emergency contact details held outside the platform.
2. Advise clients to route calls to their own voicemail or alternative number until service is restored.
3. Record all actions taken during the outage in the incident log.
4. Upon restoration, check for any calls or voicemails that arrived during the outage and process them.

### 12.4 Console Login Failure

If an operator cannot log in to the console:

1. Check that credentials are correct and that Caps Lock is not active.
2. Attempt the Forgot Password flow to reset via email.
3. If the issue persists, contact the supervisor, who will contact an administrator.
4. Administrators can reset passwords from the operator management panel.

### 12.5 Delivery Channel Failure

If message delivery is failing (email, SMS, or webhook):

1. The console displays the delivery status on each message record. Failed deliveries are flagged in red.
2. Notify the supervisor immediately.
3. The supervisor can attempt manual re-delivery or contact the client by telephone using emergency contact details.
4. The administrator should investigate the delivery configuration (SMTP credentials, Twilio account, webhook endpoint).
5. All delivery failures are recorded against the message and are visible in the audit trail.

### 12.6 Database Connectivity Issues

Database errors will cause API requests in the console to fail. If the console is returning errors on message creation or loading:

1. Refresh the browser; if the error persists, notify the supervisor.
2. The administrator should check the database connection and PostgreSQL server health.
3. During a database outage, take written notes of any calls received and process them when the system is restored.

### 12.7 Recovery and Post-Incident Review

Following any system outage:

1. A post-incident review is conducted by the administrator and Operations Manager within 24 hours.
2. The review assesses root cause, impact, and preventive measures.
3. Findings are documented and, where a client was materially affected, communicated to the client.
4. Repeat outages require escalation to the platform infrastructure team.

---

## Appendix A — Quick Reference: Status Code Cheat Sheet

| Code | Label | Max Duration | Requires Approval? |
|---|---|---|---|
| ready | Ready | No limit | No |
| busy | On Call | Call duration (auto) | No |
| comfort | Comfort Break | 10 minutes | No |
| break | Short Break | 15 minutes | Yes (notify supervisor) |
| lunch | Lunch | Per schedule | Yes (scheduled) |
| training | Training | Per schedule | Yes (pre-planned) |
| meeting | Meeting | Per schedule | Yes (pre-planned) |
| admin | Admin Work | As agreed | Yes (supervisor approval) |
| offline | Offline | N/A | No |

---

## Appendix B — Escalation Contact Matrix

| Situation | First Contact | Second Contact |
|---|---|---|
| Emergency call | Supervisor on duty | Operations Manager |
| Data breach | Supervisor on duty | Administrator / DPO |
| Abusive caller | Supervisor on duty | — |
| System outage | Supervisor on duty | Administrator |
| Delivery failure (urgent/emergency) | Supervisor on duty | Administrator |
| DSAR received | Supervisor on duty | Administrator / DPO |
| Client complaint (severe) | Supervisor on duty | Operations Manager |

*Emergency and out-of-hours contact details for supervisors, administrators, and the Operations Manager are held in the company's secure contact directory, accessible to supervisors and above.*

---

## Appendix C — Message Urgency Quick Guide

| What the caller says | Urgency Level |
|---|---|
| "It can wait" / "No rush" / "When you get a chance" | Normal |
| "As soon as possible" / "Today if possible" / "It's time-sensitive" | Urgent |
| "Emergency" / "Someone is hurt" / "Fire / flood / gas leak" / Caller is in distress | Emergency — follow Section 8.1 immediately |

---

## Document Control

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 10 May 2026 | Operations Manager | Initial release |

This document is subject to annual review or earlier review following any significant system change, incident, or regulatory update. All staff are notified of updates via the noticeboard within the operator console.
