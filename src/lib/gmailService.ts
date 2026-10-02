export interface SupportEmailData {
  username: string;
  userEmail: string;
  reasonForInquiry: string;
  optionalFeedback?: string;
  userId?: string;
  timestamp?: string;
}

export const SUPPORT_INBOX_EMAIL = "thekloakedsignal@gmail.com";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildRawEmail(data: SupportEmailData, targetInbox: string = SUPPORT_INBOX_EMAIL): string {
  const subject = `[SFT Studio Support] Inquiry from ${data.username} (${data.userEmail})`;
  const utf8Subject = `=?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  const boundary = `__boundary_${Date.now()}__`;
  
  const textBody = [
    `NEW SUPPORT INQUIRY`,
    `===================`,
    `Submitted At: ${data.timestamp || new Date().toISOString()}`,
    `Username: ${data.username}`,
    `User Email: ${data.userEmail}`,
    `User ID: ${data.userId || "guest"}`,
    ``,
    `REASON FOR INQUIRY:`,
    data.reasonForInquiry,
    ``,
    data.optionalFeedback ? `OPTIONAL FEEDBACK:\n${data.optionalFeedback}\n` : "",
    `===================`,
    `Sent from SFT Studio Pro Support Form to ${targetInbox}`
  ].filter(Boolean).join("\r\n");

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #090d16; color: #e2e8f0; margin: 0; padding: 24px; }
    .card { background-color: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 24px; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
    .header { border-bottom: 1px solid #374151; padding-bottom: 16px; margin-bottom: 20px; }
    .title { color: #10b981; font-size: 20px; font-weight: bold; margin: 0; }
    .meta { font-size: 13px; color: #9ca3af; margin-top: 6px; }
    .field { margin-bottom: 16px; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; margin-bottom: 4px; font-weight: 600; }
    .value { font-size: 14px; color: #f3f4f6; background-color: #030712; padding: 10px 14px; border-radius: 8px; border: 1px solid #1f2937; }
    .message-box { white-space: pre-wrap; font-size: 14px; line-height: 1.6; color: #f9fafb; background-color: #030712; padding: 12px 14px; border-radius: 8px; border: 1px solid #1f2937; }
    .footer { font-size: 12px; color: #6b7280; text-align: center; margin-top: 24px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <h1 class="title">SFT Studio Pro &mdash; Support Inquiry</h1>
      <div class="meta">From <strong>${escapeHtml(data.username)}</strong> &lt;<a href="mailto:${escapeHtml(data.userEmail)}" style="color: #38bdf8;">${escapeHtml(data.userEmail)}</a>&gt;</div>
    </div>

    <div class="field">
      <div class="label">User Contact Info</div>
      <div class="value">
        <strong>Name:</strong> ${escapeHtml(data.username)}<br/>
        <strong>Email:</strong> ${escapeHtml(data.userEmail)}<br/>
        <strong>Account ID:</strong> ${escapeHtml(data.userId || "guest")}
      </div>
    </div>

    <div class="field">
      <div class="label">Reason for Inquiry</div>
      <div class="message-box">${escapeHtml(data.reasonForInquiry)}</div>
    </div>

    ${data.optionalFeedback ? `
    <div class="field">
      <div class="label">Optional Feedback / Comments</div>
      <div class="message-box">${escapeHtml(data.optionalFeedback)}</div>
    </div>
    ` : ''}

    <div class="footer">
      Delivered directly to your Gmail inbox: <strong>${targetInbox}</strong><br/>
      Sent at ${new Date().toLocaleString()} via SFT Studio Pro
    </div>
  </div>
</body>
</html>
  `.trim();

  const lines = [
    `To: ${targetInbox}`,
    `Reply-To: ${data.userEmail}`,
    `Subject: ${utf8Subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    textBody,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`
  ];

  const emailRaw = lines.join("\r\n");
  // Base64URL encode without padding
  return btoa(unescape(encodeURIComponent(emailRaw)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sendSupportEmailViaGmail(
  accessToken: string,
  data: SupportEmailData,
  targetInbox: string = SUPPORT_INBOX_EMAIL
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const raw = buildRawEmail(data, targetInbox);
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ raw })
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      const msg = errJson?.error?.message || `Gmail API returned ${response.status}: ${response.statusText}`;
      console.warn("Gmail API send error:", msg);
      return { success: false, error: msg };
    }

    const result = await response.json();
    return { success: true, messageId: result.id };
  } catch (err: any) {
    console.error("Failed to send email via Gmail:", err);
    return { success: false, error: err?.message || String(err) };
  }
}
