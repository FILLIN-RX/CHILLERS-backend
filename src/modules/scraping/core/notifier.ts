import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    // Configurer avec votre service email (SMTP)
    service: 'gmail',
    auth: {
        user: 'djeutchouruxel@gmail.com', // À sécuriser via .env
        pass: 'zhao jlrm sdql ufjz' // À sécuriser via .env
    }
});

export async function sendNotification(subject: string, message: string) {
    try {
        await transporter.sendMail({
            from: 'djeutchouruxel@gmail.com',
            to: 'djeutchouruxel@gmail.com',
            subject: subject,
            text: message
        });
        console.log(`[Notification] Sent to djeutchouruxel@gmail.com`);
    } catch (error) {
        console.error(`[Notification] Failed:`, error);
    }
}
