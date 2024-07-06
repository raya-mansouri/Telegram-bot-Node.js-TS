import amqp from 'amqplib';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { PDFDocument } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { SocksProxyAgent } from 'socks-proxy-agent';
import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';

// Load environment variables from .env file
dotenv.config();

// Access the API keys from environment variables
const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY;

if (!TELEGRAM_BOT_API_KEY) {
  throw new Error('TELEGRAM_BOT_API_KEY is not defined in .env file');
}

const bot = new Telegraf(TELEGRAM_BOT_API_KEY);

// Create a SOCKS proxy agent
const proxyAgent = new SocksProxyAgent('socks5://localhost:1080');

// Function to check page speed using Lighthouse
async function checkPageSpeed(url: string): Promise<string> {
  const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--disable-gpu', '--no-sandbox'] });

  try {
    const runnerResult = await lighthouse(url, {
      logLevel: 'info' as 'info',
      output: 'json',
      onlyCategories: ['performance'],
      port: chrome.port,
    });

    if (!runnerResult || !runnerResult.lhr) {
      throw new Error('Lighthouse did not return a valid result.');
    }

    const report = runnerResult.lhr;
    const performanceScore = (report.categories.performance?.score ?? 0) * 100;
    const speedIndex = report.audits['speed-index'].displayValue;
    const firstContentfulPaint = report.audits['first-contentful-paint'].displayValue;
    const largestContentfulPaint = report.audits['largest-contentful-paint'].displayValue;
    const timeToInteractive = report.audits['interactive'].displayValue;

    const result = {
      url: report.finalDisplayedUrl,
      performanceScore,
      speedIndex,
      firstContentfulPaint,
      largestContentfulPaint,
      timeToInteractive,
    };

    const outputPath = 'lighthouse-report.json';
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

    console.log(`Lighthouse report saved to ${outputPath}`);

    return JSON.stringify(result, null, 2);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to analyze the page speed for ${url}: ${error.message}`);
    } else {
      throw new Error(`An unknown error occurred while analyzing the page speed for ${url}.`);
    }
  } finally {
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

// RabbitMQ worker
async function startWorker() {
  const connection = await amqp.connect('amqp://localhost');
  const channel = await connection.createChannel();
  const queue = 'lighthouse_tasks';

  await channel.assertQueue(queue, { durable: true });
  channel.prefetch(1);

  console.log('Worker is waiting for messages in queue...');

  channel.consume(queue, async (msg) => {
    if (msg !== null) {
      const { url, chatId } = JSON.parse(msg.content.toString());
      console.log(`Received message: url=${url}, chatId=${chatId}`);

      try {
        const speedReport = await checkPageSpeed(url);
        const pdfBuffer = await generatePDFReport(speedReport);
        const filePath = path.join(process.cwd(), 'report.pdf');
        fs.writeFileSync(filePath, pdfBuffer);
        await bot.telegram.sendDocument(chatId, { source: filePath, filename: 'report.pdf' });
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error(error);
      }

      channel.ack(msg);
    }
  });
}

startWorker();