import nodemailer from "nodemailer";
import { logger } from "./logger";

export function isSmtpConfigured(): boolean {
  return Boolean(process.env["SMTP_HOST"]?.trim());
}

export async function sendPasswordResetEmail(params: {
  to: string;
  code: string;
  businessName: string;
}): Promise<void> {
  const host = process.env["SMTP_HOST"]?.trim();
  if (!host) {
    throw new Error("SMTP_HOST is not configured");
  }

  const port = Number(process.env["SMTP_PORT"] ?? "587");
  const secure =
    process.env["SMTP_SECURE"] === "true" || port === 465;
  const user = process.env["SMTP_USER"]?.trim();
  const pass = process.env["SMTP_PASS"]?.trim();
  const from =
    process.env["SMTP_FROM"]?.trim() ||
    (user ? `${params.businessName} <${user}>` : `${params.businessName} <no-reply@smartbuy.co.ke>`);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
  });

  await transporter.sendMail({
    from,
    to: params.to,
    subject: `${params.businessName} — Password Reset Code`,
    text: `Your ${params.businessName} password reset code is: ${params.code}\n\nThis code expires in 15 minutes. If you did not request a password reset, you can ignore this email.`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px;">${params.businessName} Password Reset</h2>
        <p style="color: #444; line-height: 1.5;">Use the verification code below to reset your password. It expires in 15 minutes.</p>
        <div style="margin: 20px 0; padding: 16px; background: #f4f4f5; border-radius: 8px; text-align: center; font-size: 28px; font-weight: bold; letter-spacing: 6px;">
          ${params.code}
        </div>
        <p style="color: #666; font-size: 13px;">If you did not request this reset, you can safely ignore this email.</p>
      </div>
    `,
  });

  logger.info({ to: params.to }, "Password reset email sent via SMTP");
}
