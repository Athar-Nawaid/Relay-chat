import 'dotenv/config';
import nodemailer from "nodemailer";

// Create a transporter using SMTP

const smtpPort = Number(process.env.SMTP_PORT ?? 587);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? "smtp.gmail.com",
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export default async function sendEmail({ to, subject, text }) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    // eslint-disable-next-line no-console
    console.warn('[mail.service] SMTP_USER or SMTP_PASS not set; skipping email.');
    return { skipped: true };
  }

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
  };
}

