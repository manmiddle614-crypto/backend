import nodemailer from 'nodemailer';

class EmailService {
  constructor() {
    this.transporter = null;
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return;

    const emailConfig = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    };

    // Check if email is configured
    if (!emailConfig.auth.user || !emailConfig.auth.pass) {
      return;
    }

    this.transporter = nodemailer.createTransport(emailConfig);
    this.initialized = true;
  }

  isConfigured() {
    this.initialize();
    return this.initialized && this.transporter !== null;
  }

  async sendOTP(email, otp, purpose = 'password_reset') {
    if (!this.isConfigured()) {
      throw new Error('Email service not configured. Please set SMTP environment variables.');
    }

    const subject = purpose === 'password_reset' 
      ? 'Password Reset OTP - SmartMess'
      : 'Email Verification OTP - SmartMess';

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .otp-box { background: white; border: 2px dashed #667eea; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px; }
          .otp-code { font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 8px; }
          .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 12px; margin: 20px 0; }
          .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Password Reset Request</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>You requested to reset your password for your SmartMess admin account.</p>
            
            <div class="otp-box">
              <p style="margin: 0; font-size: 14px; color: #666;">Your OTP Code:</p>
              <div class="otp-code">${otp}</div>
              <p style="margin: 10px 0 0 0; font-size: 12px; color: #999;">Valid for 10 minutes</p>
            </div>

            <p>Enter this code on the password reset page to continue.</p>

            <div class="warning">
              <strong>⚠️ Security Notice:</strong><br>
              • Do not share this OTP with anyone<br>
              • This OTP expires in 10 minutes<br>
              • If you didn't request this, please ignore this email
            </div>

            <p>If you didn't request a password reset, you can safely ignore this email.</p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} SmartMess. All rights reserved.</p>
            <p>This is an automated email. Please do not reply.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"SmartMess" <${process.env.SMTP_USER}>`,
      to: email,
      subject,
      html
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }
  }

  async sendPasswordResetSuccess(email, name) {
    if (!this.isConfigured()) {
      return;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #11998e 0%, #38ef7d 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .success-icon { font-size: 48px; margin-bottom: 10px; }
          .footer { text-align: center; color: #666; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="success-icon">✅</div>
            <h1>Password Reset Successful</h1>
          </div>
          <div class="content">
            <p>Hello ${name || 'Admin'},</p>
            <p>Your password has been successfully reset for your SmartMess admin account.</p>
            <p>You can now log in with your new password.</p>
            <p><strong>If you didn't make this change, please contact support immediately.</strong></p>
          </div>
          <div class="footer">
            <p>© ${new Date().getFullYear()} SmartMess. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const mailOptions = {
      from: `"SmartMess" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Password Reset Successful - SmartMess',
      html
    };

    try {
      await this.transporter.sendMail(mailOptions);
    } catch (error) {
      // Silent fail for success notification
    }
  }
}

export const emailService = new EmailService();
