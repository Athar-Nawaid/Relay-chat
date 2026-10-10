import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function sendEmail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) return { skipped: true };

  return await resend.emails.send({
    from: 'Relay Notifications <onboarding@resend.dev>',
    to,
    subject,
    text,
  });
}