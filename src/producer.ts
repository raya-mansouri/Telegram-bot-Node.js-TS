import { Telegraf } from 'telegraf';
import { CronJob } from 'cron';
import * as amqp from 'amqplib';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Access the API keys from environment variables
const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY;

if (!TELEGRAM_BOT_API_KEY) {
  throw new Error('TELEGRAM_BOT_API_KEY is not defined in .env file');
}

const bot = new Telegraf(TELEGRAM_BOT_API_KEY);

// RabbitMQ connection
async function sendToQueue(url: string, chatId: number) {
  const connection = await amqp.connect('amqp://localhost');
  const channel = await connection.createChannel();
  const queue = 'lighthouse_tasks';

  await channel.assertQueue(queue, { durable: true });

  const message = JSON.stringify({ url, chatId });
  channel.sendToQueue(queue, Buffer.from(message), { persistent: true });

  console.log(`Sent message to queue: ${message}`);
  await channel.close();
  await connection.close();
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
    await sendToQueue(url, ctx.chat.id);
    ctx.reply('Your request has been queued. You will receive the report shortly.');
  } catch (error) {
    console.error(error);
    ctx.reply('Failed to queue your request.');
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
        await sendToQueue(url, parseInt(chatId));
      } catch (error) {
        console.error(error);
      }
    }
  }
}, null, true, 'Asia/Tehran');

bot.launch();