import asyncio
import logging
import os
import re
import sys
from uuid import uuid4

from aiogram import Bot, Dispatcher, executor, types
from aiogram.types import InlineQuery, InputTextMessageContent, InlineQueryResultArticle, InputFile

TOKEN = "СосиТотКтоЮзаетГуглДорки"

RESULTS_DIR = "bot_results"
os.makedirs(RESULTS_DIR, exist_ok=True)

bot = Bot(token=TOKEN, parse_mode=types.ParseMode.HTML)
dp = Dispatcher(bot)
logging.basicConfig(level=logging.INFO)


def is_safe_username(username: str) -> bool:
    safe_pattern = re.compile(r"^[a-zA-Z0-9_.-]{3,30}$")
    return bool(safe_pattern.match(username))

def count_results_in_file(file_path: str) -> int:
    """Улучшенная функция подсчета, считает только строки со ссылками."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = [line for line in f if line.strip().startswith("http")]
            return len(lines)
    except (IOError, FileNotFoundError):
        return 0

async def run_sherlock_search(username: str) -> str | None:
    report_path = os.path.join(RESULTS_DIR, f"{username}.txt")
    command = [
        "sherlock",
        username,
        "--print-found",
        "--folderoutput", RESULTS_DIR,
        "--no-color",
        "--timeout", "15"
    ]
    
    logging.info(f"Запускаю Sherlock для {username}: {' '.join(command)}")
    
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE
    )
    
    stdout, stderr = await process.communicate()
    
    if process.returncode != 0:
        logging.error(f"Sherlock для {username} завершился с ошибкой: {stderr.decode()}")
        return None

    if os.path.exists(report_path):
        return report_path
    
    return None

@dp.message_handler(commands=['start'])
async def send_welcome(message: types.Message):
    await message.reply(
        "👋 Привет! Я OSS-бот на базе Sherlock.\n\n"
        "➡️ Используй команду <code>/search &lt;юзернейм&lt;</code> для поиска.\n"
        "🌐 Или попробуй инлайн-режим в любом чате: <code>@имя_бота &lt;юзернейм&lt;</code>"
    )

@dp.message_handler(commands=['search'])
async def search_handler(message: types.Message):
    try:
        username = message.text.split(maxsplit=1)[1]
    except IndexError:
        await message.reply("<b>Неправильный формат.</b>\nИспользуйте: <code>/search &lt;юзернейм&lt;</code>")
        return

    if not is_safe_username(username):
        await message.reply("⚠️ <b>[Защита] Увы сработала защита и этот ник нельзя искать!</b>\n\n"
                            "Используйте только буквы, цифры, и символы <code>._-</code> (длина 3-30).\n"
                            "Пробелы и другие знаки запрещены.")
        return

    report_path = os.path.join(RESULTS_DIR, f"{username}.txt")

    if os.path.exists(report_path):
        logging.info(f"Отправка отчета для {username} из кэша.")
        results_count = count_results_in_file(report_path)
        if results_count > 0:
            await message.reply_document(
                InputFile(report_path),
                caption=f"✅ Отчет из кэша для <b>{username}</b>.\n"
                        f"Найдено аккаунтов: <b>{results_count}</b>"
            )
        else:
            await message.reply(f"❌ В кэше есть отчет для <b>{username}</b>, но в нем не найдено аккаунтов.")
        return

    wait_message = await message.reply(f"⏳ Начинаю поиск по юзернейму <b>{username}</b>. Это может занять несколько минут...")
    
    new_report_path = await run_sherlock_search(username)
    
    await wait_message.delete()

    if new_report_path:
        results_count = count_results_in_file(new_report_path)
        if results_count > 0:
            await message.reply_document(
                InputFile(new_report_path),
                caption=f"✅ Готово! Отчет для <b>{username}</b>.\n"
                        f"Найдено аккаунтов: <b>{results_count}</b>"
            )
        else:
            await message.reply(f"❌ По юзернейму <b>{username}</b> ничего не найдено.")
    else:
        await message.reply(f"❌ По юзернейму <b>{username}</b> ничего не найдено или произошла ошибка при поиске.")


@dp.inline_handler()
async def inline_search(inline_query: InlineQuery):
    username = inline_query.query.strip()

    if not username:
        result = InlineQueryResultArticle(
            id=str(uuid4()),
            title="Начните вводить юзернейм",
            description="Введите ник для поиска по соцсетям.",
            input_message_content=InputTextMessageContent("Введите юзернейм для поиска с помощью @имя_бота."),
        )
        await bot.answer_inline_query(inline_query.id, results=[result], cache_time=1)
        return

    if not is_safe_username(username):
        result = InlineQueryResultArticle(
            id=str(uuid4()),
            title="Небезопасный юзернейм",
            description="Используйте только буквы, цифры, и символы ._-",
            input_message_content=InputTextMessageContent("Попытка ввода небезопасного юзернейма."),
        )
        await bot.answer_inline_query(inline_query.id, results=[result], cache_time=1)
        return
        
    report_path = os.path.join(RESULTS_DIR, f"{username}.txt")
    
    if os.path.exists(report_path):
        results_count = count_results_in_file(report_path)
        
        if results_count > 0:
            with open(report_path, 'r', encoding='utf-8') as f:
                all_lines = [line for line in f.readlines() if line.strip().startswith("http")]
                preview_lines = all_lines[:15]
                links_text = "".join(preview_lines)

            message_text = f"<b>Отчет для {username} (найдено {results_count}):</b>\n\n{links_text}"
            
            if len(all_lines) > 15:
                message_text += "\n<i>...и другие (полный отчет в файле по команде /search)</i>"
            
            result = InlineQueryResultArticle(
                id=str(uuid4()),
                title=f"Отчет по {username}",
                description=f"Найдено на {results_count} сайтах. Нажмите, чтобы отправить.",
                input_message_content=InputTextMessageContent(message_text, parse_mode='HTML'),
            )
        else:
            result = InlineQueryResultArticle(
                id=str(uuid4()),
                title=f"Ничего не найдено для '{username}'",
                description="Поиск завершен, аккаунты не обнаружены.",
                input_message_content=InputTextMessageContent(f"Поиск по юзернейму '{username}' не дал результатов."),
            )
    else:
        result = InlineQueryResultArticle(
            id=str(uuid4()),
            title=f"Запустить поиск для '{username}'",
            description="Этот юзернейм еще не искали. Нажмите, чтобы отправить команду боту.",
            input_message_content=InputTextMessageContent(f"/search {username}"),
        )
    
    await bot.answer_inline_query(inline_query.id, results=[result], cache_time=1)

if __name__ == '__main__':
    logging.info("Бот запускается...")
    executor.start_polling(dp, skip_updates=True)
