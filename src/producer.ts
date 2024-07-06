import { Telegraf } from 'telegraf';
import { CronJob } from 'cron';
import * as amqp from 'amqplib';
import dotenv from 'dotenv';
import { Sequelize, DataTypes, Model } from 'sequelize';

// Load environment variables from .env file
dotenv.config();

const TELEGRAM_BOT_API_KEY = process.env.TELEGRAM_BOT_API_KEY;

if (!TELEGRAM_BOT_API_KEY) {
  throw new Error('TELEGRAM_BOT_API_KEY is not defined in .env file');
}

const bot = new Telegraf(TELEGRAM_BOT_API_KEY);

// Database setup
const sequelize = new Sequelize(process.env.DATABASE_URL!, {
  dialect: 'postgres',
  logging: false,
});

class ScheduledReport extends Model {
  public id!: number;
  public chatId!: number;
  public url!: string;
  public hour!: number;
  public minute!: number;
}

ScheduledReport.init({
  chatId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  url: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  hour: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  minute: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
}, {
  sequelize,
  modelName: 'ScheduledReport',
  tableName: 'scheduled_reports',
  timestamps: false,
});

async function syncDatabase() {
  await sequelize.sync();
}

syncDatabase().catch(console.error);

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
/schedule <URL> <HH:MM> - Schedule a daily report for the specified URL at the specified hour and minute (24-hour format)
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

// Handle /schedule command
bot.command('schedule', async (ctx) => {
  const [command, url, time] = ctx.message.text.split(' ');
  const chatId = ctx.chat.id;
  const [hour, minute] = time.split(':').map(Number);

  if (!url || isNaN(hour) || isNaN(minute)) {
    return ctx.reply('Usage: /schedule <URL> <HH:MM>');
  }

  await ScheduledReport.create({
    chatId: chatId,
    url: url,
    hour: hour,
    minute: minute,
  });

  ctx.reply(`Scheduled daily report for ${url} at ${hour}:${minute}.`);
});

// Set up cron jobs for daily reports
new CronJob('* * * * *', async () => {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  const reports = await ScheduledReport.findAll({
    where: {
      hour: currentHour,
      minute: currentMinute,
    }
  });

  for (const report of reports) {
    try {
      await sendToQueue(report.url, report.chatId);
      console.log(`Queued scheduled report for ${report.url} at ${report.hour}:${report.minute} for chatId=${report.chatId}`);
    } catch (error) {
      console.error(`Failed to queue scheduled report for ${report.url} at ${report.hour}:${report.minute} for chatId=${report.chatId}`, error);
    }
  }
}, null, true, 'Asia/Tehran');

bot.launch();