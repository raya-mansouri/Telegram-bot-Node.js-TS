import { Telegraf } from 'telegraf';
import axios from 'axios';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { PDFDocument } from 'pdf-lib';
import { CronJob } from 'cron';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

  // Create a SOCKS proxy agent
  const proxyAgent = new SocksProxyAgent('socks5://localhost:1080'); 

// Access the API keys from environment variables
const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY;
const GOOGLE_PAGE_SPEED_API_KEY = process.env.GOOGLE_PAGE_SPEED_API_KEY;

if (!TELEGRAM_BOT_API_KEY) {
  throw new Error('TELEGRAM_BOT_API_KEY is not defined in .env file');
}

if (!GOOGLE_PAGE_SPEED_API_KEY) {
  throw new Error('GOOGLE_PAGE_SPEED_API_KEY is not defined in .env file');
}

const bot = new Telegraf(TELEGRAM_BOT_API_KEY);

// Function to check page speed using Lighthouse
async function checkPageSpeed(url: string): Promise<string> {
  // Launch a headless Chrome instance
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--disable-gpu', '--no-sandbox'] });

  try {
      // Run Lighthouse audit
      const runnerResult = await lighthouse(url, {
        logLevel: 'info' as 'info', // Cast logLevel to one of the allowed literal types
        output: 'json',
        onlyCategories: ['performance'],
        port: chrome.port,
    }
  );

      // Check if runnerResult is defined and contains the required fields
      if (!runnerResult || !runnerResult.lhr) {
          throw new Error('Lighthouse did not return a valid result.');
      }

      // `.lhr` is the Lighthouse Result Object
      const report = runnerResult.lhr;

      // Extract key performance metrics
      const performanceScore = (report.categories.performance?.score ?? 0) * 100; // Performance score (0-100 scale)
      const speedIndex = report.audits['speed-index'].displayValue; // Speed Index
      const firstContentfulPaint = report.audits['first-contentful-paint'].displayValue; // First Contentful Paint (FCP)
      const largestContentfulPaint = report.audits['largest-contentful-paint'].displayValue; // Largest Contentful Paint (LCP)
      const timeToInteractive = report.audits['interactive'].displayValue; // Time to Interactive (TTI)

      // Prepare the result object with key metrics
      const result = {
          url: report.finalDisplayedUrl,
          performanceScore: performanceScore,
          speedIndex: speedIndex,
          firstContentfulPaint: firstContentfulPaint,
          largestContentfulPaint: largestContentfulPaint,
          timeToInteractive: timeToInteractive,
      };

      // Optionally, save the full report to a file (JSON or HTML based on options)
      const outputPath = 'lighthouse-report.json';
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

      console.log(`Lighthouse report saved to ${outputPath}`);

      // Return the formatted result as a JSON string
      return JSON.stringify(result, null, 2);

  } catch (error) {
      // Error handling
      if (error instanceof Error) {
          throw new Error(`Failed to analyze the page speed for ${url}: ${error.message}`);
      } else {
          throw new Error(`An unknown error occurred while analyzing the page speed for ${url}.`);
      }
  } finally {
      // Ensure Chrome is closed after the audit
      await chrome.kill();
  }
}

// Function to generate PDF report
async function generatePDFReport(content: string): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage();
  page.drawText(content, { x: 50, y: 700, size: 12 });
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// Handle /start command
bot.start((ctx) => {
    ctx.reply('Welcome! Use /help to see the available commands.');
  });
  
  // Handle /help command
  bot.command('help', (ctx) => {
    const helpMessage = `
  Available commands:
  /start - Start the bot
  /help - Show this help message
  /check <URL> - Check the page speed of a website
  /schedule <URL> <HOUR> - Schedule a daily report for the specified URL at the specified hour (24-hour format)
    `;
    ctx.reply(helpMessage);
  });

// Handle /check command
bot.command('check', async (ctx) => {
  const url = ctx.message.text.split(' ')[1];
  if (!url) {
    return ctx.reply('Please provide a URL.');
  }
  try {
    const speedReport = await checkPageSpeed(url);
    const pdfBuffer = await generatePDFReport(speedReport);
    const filePath = path.join(process.cwd(), 'report.pdf');
    fs.writeFileSync(filePath, pdfBuffer);
    await ctx.replyWithDocument({ source: filePath, filename: 'report.pdf' });
    fs.unlinkSync(filePath); // Clean up the file
  } catch (error) {
    console.error(error);
    ctx.reply('Failed to check the page speed.');
  }
});

// Schedule daily reports
const scheduledReports: { [chatId: number]: { url: string, hour: number, minute: number } } = {};

bot.command('schedule', (ctx) => {
  const [command, url, time] = ctx.message.text.split(' ');
  const chatId = ctx.chat.id;
  const [hour, minute] = time.split(':').map(Number);

  if (!url || isNaN(hour) || isNaN(minute)) {
    return ctx.reply('Usage: /schedule <URL> <HH:MM>');
  }

  scheduledReports[chatId] = { url, hour, minute };
  ctx.reply(`Scheduled daily report for ${url} at ${hour}:${minute}.`);
});

// Set up cron jobs for daily reports
new CronJob('* * * * *', async () => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  for (const chatId in scheduledReports) {
    const { url, hour, minute } = scheduledReports[chatId];
    if (hour === currentHour && minute === currentMinute) {
      try {
        const speedReport = await checkPageSpeed(url);
        const pdfBuffer = await generatePDFReport(speedReport);
        const filePath = path.join(process.cwd(), 'report.pdf');
        fs.writeFileSync(filePath, pdfBuffer);
        await bot.telegram.sendDocument(chatId, { source: filePath, filename: 'report.pdf' });
        fs.unlinkSync(filePath); // Clean up the file
      } catch (error) {
        console.error(error);
      }
    }
  }
}, null, true, 'Asia/Tehran');

bot.launch();