// Cortex Cloud — Email via Resend API

const FROM = 'Cortex <noreply@auth.eontech.pro>'

interface SendResult {
  ok: boolean
  id?: string
  error?: string
}

export async function sendOTPEmail(to: string, code: string): Promise<SendResult> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0f;color:#e0e0e0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;padding:32px;background:#111118;border-radius:12px;border:1px solid #1e1e2e;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:24px;font-weight:700;color:#c5ff3d;letter-spacing:-0.5px;">Cortex</span>
      <span style="font-size:14px;color:#666;margin-left:8px;">by Eontech</span>
    </div>
    <p style="margin:0 0 16px;font-size:15px;color:#ccc;">Your verification code:</p>
    <div style="text-align:center;margin:24px 0;">
      <span style="font-family:'JetBrains Mono',monospace;font-size:36px;font-weight:700;color:#c5ff3d;letter-spacing:8px;background:#0a0a0f;padding:16px 32px;border-radius:8px;border:1px solid #1e1e2e;">${code}</span>
    </div>
    <p style="margin:16px 0 0;font-size:13px;color:#666;">This code expires in 5 minutes. If you didn't request this, ignore this email.</p>
  </div>
</body>
</html>`

  const apiKey = process.env.RESEND_API_KEY || ''
  if (!apiKey) {
    console.log(`[cortex-cloud] OTP for ${to}: ${code} (no RESEND_API_KEY, logged only)`)
    return { ok: true, id: 'dev-console' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: 'Your Cortex verification code',
        html,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[cortex-cloud] Resend error: ${res.status} ${text}`)
      return { ok: false, error: text }
    }

    const data = await res.json() as { id: string }
    return { ok: true, id: data.id }
  } catch (err) {
    console.error('[cortex-cloud] Email send failed:', err)
    return { ok: false, error: String(err) }
  }
}

export async function sendLicenseKeyEmail(to: string, licenseKey: string, plan: string): Promise<SendResult> {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1)
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0f;color:#e0e0e0;font-family:'Helvetica Neue',Arial,sans-serif;">
  <div style="max-width:520px;margin:40px auto;padding:32px;background:#111118;border-radius:12px;border:1px solid #1e1e2e;">
    <div style="text-align:center;margin-bottom:24px;">
      <span style="font-size:24px;font-weight:700;color:#c5ff3d;letter-spacing:-0.5px;">Cortex</span>
      <span style="font-size:14px;color:#666;margin-left:8px;">by Eontech</span>
    </div>
    <p style="margin:0 0 8px;font-size:18px;font-weight:600;color:#fff;">Welcome to Cortex ${planLabel}!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#ccc;">Your license key is ready. Use it to activate Cortex on your machine:</p>
    <div style="background:#0a0a0f;border:1px solid #1e1e2e;border-radius:8px;padding:16px;margin:0 0 20px;">
      <code style="font-family:'JetBrains Mono',monospace;font-size:13px;color:#c5ff3d;word-break:break-all;">${licenseKey}</code>
    </div>
    <div style="background:#0a0a0f;border:1px solid #1e1e2e;border-radius:8px;padding:16px;margin:0 0 20px;">
      <p style="margin:0 0 8px;font-size:13px;color:#888;">Activate with:</p>
      <code style="font-family:'JetBrains Mono',monospace;font-size:14px;color:#fff;">npx mem-ria activate ${licenseKey}</code>
    </div>
    <p style="margin:0 0 8px;font-size:14px;color:#ccc;">You can also log in to your dashboard at:</p>
    <a href="https://cortex.eontech.pro/app/" style="color:#c5ff3d;font-size:14px;">cortex.eontech.pro/app/</a>
    <p style="margin:20px 0 0;font-size:12px;color:#555;">This key is valid for 365 days. Keep it safe.</p>
  </div>
</body>
</html>`

  const apiKey = process.env.RESEND_API_KEY || ''
  if (!apiKey) {
    console.log(`[cortex-cloud] License key for ${to}: ${licenseKey} (no RESEND_API_KEY, logged only)`)
    return { ok: true, id: 'dev-console' }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: `Your Cortex ${planLabel} license key`,
        html,
      }),
    })

    if (!res.ok) {
      const text = await res.text()
      console.error(`[cortex-cloud] Resend error: ${res.status} ${text}`)
      return { ok: false, error: text }
    }

    const data = await res.json() as { id: string }
    return { ok: true, id: data.id }
  } catch (err) {
    console.error('[cortex-cloud] License email send failed:', err)
    return { ok: false, error: String(err) }
  }
}
