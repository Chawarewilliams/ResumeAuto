# ResumeAuto v2.1 - Upgraded Edition

A powerful Gmail-based bulk email sender for job applications with advanced features, analytics, and a live dashboard.

## 🚀 Recent Upgrades (v2.1)

### Security Improvements
- ✅ **Environment Variables**: All sensitive credentials now configurable via `.env` file
- ✅ **Vulnerability Fixes**: Updated nodemailer (9.1.1) and imap (0.8.17) to fix security issues
- ✅ **Git Protection**: Added `.gitignore` to prevent accidental credential commits

### Dependency Updates
- `nodemailer`: 8.0.7 → 9.1.1 (SMTP security fixes)
- `imap`: 0.8.19 → 0.8.17 (Vulnerability fixes)
- `mailparser`: 3.9.15 → 3.9.20 (Improvements)
- `pg`: 8.22.0 → 8.23.0 (Bug fixes)
- `dotenv`: ^17.4.2 (Already latest)
- `express`: ^5.2.1 (Already latest)

### Code Quality
- ✅ Configuration validation function added
- ✅ Better error handling and logging
- ✅ `.env.example` file with all available options
- ✅ Input validation for all config values

### Features Preserved
- ✅ Multiple Gmail accounts (auto rotate)
- ✅ HTML beautiful email templates
- ✅ Speed control (fast / medium / slow)
- ✅ Failed emails auto-retry
- ✅ Multiple txt file support
- ✅ Personalized email (Company name support)
- ✅ Already sent emails skip
- ✅ Live Dashboard (http://localhost:3000)
- ✅ Template Manager
- ✅ Email List Manager
- ✅ Analytics Tab with charts & ETA
- ✅ Job Tracker
- ✅ Skip @gmail.com addresses

## 🔧 Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Credentials
Create a `.env` file from the template:
```bash
cp .env.example .env
```

Edit `.env` and add your Gmail details:
```
GMAIL_ADDRESS=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-character-app-password
# Optional second Gmail sender (both values required)
GMAIL_ADDRESS_2=second-email@gmail.com
GMAIL_APP_PASSWORD_2=second-app-password
ATTACHMENT_PATH=./path/to/your/resume.pdf
DASHBOARD_PORT=3000
```

> **Note**: Use [Google App Passwords](https://myaccount.google.com/apppasswords) (not your regular Gmail password)

### 3. Prepare Email Lists
Create a text file with emails (e.g., `emails.txt`):
```
recruiter1@company.com, Company Name
recruiter2@company.com, Another Company
# Comments starting with # are ignored
```

### 4. Run the Application
```bash
npm start
# or for development with auto-reload
npm run dev
```

### 5. Access Dashboard
Open your browser and go to: **http://localhost:3000**

## 📋 Configuration Options

All configuration can be set via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GMAIL_ADDRESS` | - | Your Gmail email address |
| `GMAIL_APP_PASSWORD` | - | Gmail app-specific password |
| `EMAIL_SPEED` | medium | fast, medium, or slow |
| `MAX_RETRIES` | 3 | Retry attempts for failed emails |
| `DAILY_LIMIT` | 450 | Max emails per account per day |
| `ATTACHMENT_PATH` | ./resume.pdf | Path to resume file |
| `ATTACHMENT_ENABLED` | true | Attach resume to emails |
| `DASHBOARD_PORT` | 3000 | Web dashboard port |
| `HUMAN_JITTER` | true | Add random delays |
| `SKIP_WEEKENDS` | true | Don't send on weekends |
| `BUSINESS_HOURS_ONLY` | false | Only send during business hours |

For complete list, see `.env.example`

## 📊 Dashboard Features

- **Send Control**: Start, pause, stop email sending
- **Template Manager**: Edit email subjects and HTML on the fly
- **Email List Manager**: Upload/manage recipient lists
- **Analytics**: Charts, success rates, ETA
- **Job Tracker**: Track every application with status
- **Settings**: Live configuration changes
- **Inbox Checker**: Check for recruiter replies

## 🛡️ Security Best Practices

1. **Never commit `.env`** - It's in `.gitignore` for safety
2. **Use App Passwords** - Google requires app-specific passwords for SMTP
3. **Rotate Credentials** - Change passwords periodically
4. **Secure .env file** - Restrict file permissions on production servers
5. **Environment Validation** - Config errors are caught at startup

## 📝 File Structure

```
ResumeAuto/
├── send_emails.js          # Main application
├── clean_emails.js         # Email validation utility
├── package.json            # Dependencies (upgraded)
├── .env                    # Configuration (create from .env.example)
├── .env.example            # Configuration template
├── .gitignore              # Git ignore rules
├── emails.txt              # Email list
├── template.json           # Email template
├── settings.json           # Application settings
├── sent_log.txt            # Log of sent emails
├── jobs.json               # Job application tracker
└── README.md               # This file
```

## 🐛 Troubleshooting

### "Cannot find module dotenv"
```bash
npm install
```

### Gmail Authentication Failed
- Verify your email and app password in `.env`
- Use a Google App Password, not your regular Gmail password. App Passwords require 2-Step Verification on the Google account.
- Check the Google account security settings and remove/recreate the app password if it was revoked.

### Emails Being Rejected
- Ensure email list format is correct: `email@company.com, Company Name`
- Verify recipients are valid
- Check Gmail sending limits (450/day per account)

### Dashboard Not Loading
- Check if port 3000 is available: `netstat -ano | findstr :3000`
- Change port in `.env`: `DASHBOARD_PORT=3001`

## 📈 Tips & Tricks

1. **Multiple Accounts**: Set `GMAIL_ADDRESS_2` and `GMAIL_APP_PASSWORD_2` for a second sender. Recipients already recorded in `sent_log.txt` remain skipped.
2. **Smart Sending**: Set `EMAIL_SPEED=slow` for better deliverability
3. **Personalization**: Use `{company}` in subject for custom text
4. **Tracking**: Check `jobs.json` for application status
5. **Safety**: Start with `DAILY_LIMIT=50` to test

## 📞 Support

For issues, check the logs in the dashboard and verify your `.env` configuration matches `.env.example`.

---

**Version**: 2.1  
**Last Updated**: 2026-09-02  
**Security Vulnerabilities**: 0  
**Dependencies**: All up-to-date
