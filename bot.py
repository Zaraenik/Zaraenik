import os, json, time, threading
from pathlib import Path
import telebot
from telebot import types
from flask import Flask

BOT_TOKEN = os.getenv("BOT_TOKEN", "")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
SUPPORT = "@Artemwesh"
DATA_FILE = Path("data.json")
LOCK = threading.Lock()

bot = telebot.TeleBot(BOT_TOKEN, parse_mode="HTML")

PACKS = {
    "50": {"stars": 50, "uah": "15 грн"},
    "100": {"stars": 100, "uah": "28 грн 33 коп"}
}

def default_data():
    return {"users": {}, "requests": {}, "last_request_id": 0, "reviews": [], "settings": {"exchange_enabled": True}}

def load_data():
    if not DATA_FILE.exists():
        return default_data()
    try:
        data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        data = default_data()
    data.setdefault("users", {})
    data.setdefault("requests", {})
    data.setdefault("last_request_id", 0)
    data.setdefault("reviews", [])
    data.setdefault("settings", {})
    data["settings"].setdefault("exchange_enabled", True)
    return data

def save_data(data):
    DATA_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

def get_user(data, user_id, username=""):
    uid = str(user_id)
    if uid not in data["users"]:
        data["users"][uid] = {"username": username or "", "state": None, "pack": None, "card": None}
    u = data["users"][uid]
    u["username"] = username or u.get("username", "")
    u.setdefault("state", None)
    u.setdefault("pack", None)
    u.setdefault("card", None)
    return u

def main_menu():
    kb = types.ReplyKeyboardMarkup(resize_keyboard=True)
    kb.row("⭐ Обменять Stars", "📊 Курс")
    kb.row("📋 Мои заявки", "⭐ Отзывы")
    kb.row("❓ FAQ", "🛠 Поддержка")
    return kb

def packs_kb():
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("⭐ 50 Stars → 15 грн", callback_data="pack_50"))
    kb.add(types.InlineKeyboardButton("⭐ 100 Stars → 28 грн 33 коп", callback_data="pack_100"))
    kb.add(types.InlineKeyboardButton("❌ Отмена", callback_data="cancel"))
    return kb

def admin_kb(rid):
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("✅ Выплачено", callback_data=f"paid_{rid}"),
           types.InlineKeyboardButton("❌ Отказать", callback_data=f"reject_{rid}"))
    return kb

@bot.message_handler(commands=["start"])
def start(m):
    with LOCK:
        data = load_data()
        u = get_user(data, m.from_user.id, m.from_user.username or "")
        u["state"] = None
        save_data(data)
    bot.send_message(m.chat.id,
        "👋 <b>Добро пожаловать в обмен Stars!</b>\n\n"
        "Здесь вы можете обменять Telegram Stars на гривны.\n\n"
        "💱 <b>Курс:</b>\n3 ⭐ = 1 грн\n\n"
        "📌 Минимум обмена: 50 ⭐\n"
        "⏳ Выплаты проходят 1 раз в день вечером.\n"
        "🛡 Все заявки проверяются вручную.\n\n"
        "👇 Выберите действие:", reply_markup=main_menu())

@bot.message_handler(func=lambda m: m.text == "⭐ Обменять Stars")
def exchange(m):
    with LOCK:
        data = load_data()
        u = get_user(data, m.from_user.id, m.from_user.username or "")
        if not data["settings"].get("exchange_enabled", True):
            return bot.send_message(m.chat.id, "⛔ Обмен временно недоступен.", reply_markup=main_menu())
        u["state"] = "choose"
        save_data(data)
    bot.send_message(m.chat.id,
        "💱 <b>Обмен Stars</b>\n\n"
        "Выберите сумму обмена:\n\n"
        "⭐ 50 Stars → 15 грн\n"
        "⭐ 100 Stars → 28 грн 33 коп\n\n"
        "⏳ Выплаты проходят 1 раз в день вечером.", reply_markup=packs_kb())

@bot.callback_query_handler(func=lambda c: c.data.startswith("pack_") or c.data == "cancel")
def pack_select(c):
    with LOCK:
        data = load_data()
        u = get_user(data, c.from_user.id, c.from_user.username or "")
        if c.data == "cancel":
            u["state"] = None; u["pack"] = None; u["card"] = None
            save_data(data)
            bot.answer_callback_query(c.id, "Отменено")
            return bot.send_message(c.message.chat.id, "✅ Отменено.", reply_markup=main_menu())
        pack_id = c.data.split("_")[1]
        if pack_id not in PACKS:
            return bot.answer_callback_query(c.id, "Ошибка", show_alert=True)
        u["state"] = "card"
        u["pack"] = pack_id
        save_data(data)
    p = PACKS[pack_id]
    bot.answer_callback_query(c.id, "Выбрано")
    bot.send_message(c.message.chat.id,
        f"✅ Вы выбрали: <b>{p['stars']} Stars</b>\n"
        f"💸 К выплате: <b>{p['uah']}</b>\n\n"
        "💳 Отправьте номер карты/реквизиты для выплаты.")

@bot.message_handler(content_types=["photo"])
def photo(m):
    with LOCK:
        data = load_data()
        u = get_user(data, m.from_user.id, m.from_user.username or "")
        if u.get("state") != "screen":
            return bot.send_message(m.chat.id, "📸 Сначала создайте заявку через «Обменять Stars».")
        pack = PACKS[u["pack"]]
        data["last_request_id"] += 1
        rid = str(data["last_request_id"])
        data["requests"][rid] = {
            "user_id": str(m.from_user.id), "username": m.from_user.username or "",
            "stars": pack["stars"], "uah": pack["uah"], "card": u["card"],
            "status": "wait", "time": int(time.time()), "photo_file_id": m.photo[-1].file_id
        }
        u["state"] = None; u["pack"] = None; u["card"] = None
        save_data(data)
    bot.send_message(m.chat.id,
        f"✅ <b>Заявка #{rid} создана</b>\n\n"
        f"⭐ Stars: <b>{pack['stars']}</b>\n"
        f"💸 К выплате: <b>{pack['uah']}</b>\n\n"
        "⏳ Заявка отправлена на проверку. Выплаты вечером, до 24 часов.",
        reply_markup=main_menu())
    bot.send_photo(ADMIN_ID, m.photo[-1].file_id,
        caption=(f"⭐ <b>Новая заявка #{rid}</b>\n\n"
                 f"👤 @{m.from_user.username or 'нет'}\n🆔 <code>{m.from_user.id}</code>\n"
                 f"⭐ Stars: <b>{pack['stars']}</b>\n💸 К выплате: <b>{pack['uah']}</b>\n"
                 f"💳 Карта: <code>{data['requests'][rid]['card']}</code>"),
        reply_markup=admin_kb(rid))

@bot.callback_query_handler(func=lambda c: c.data.startswith("paid_") or c.data.startswith("reject_"))
def admin_action(c):
    if c.from_user.id != ADMIN_ID:
        return bot.answer_callback_query(c.id, "Нет доступа", show_alert=True)
    action, rid = c.data.split("_", 1)
    with LOCK:
        data = load_data()
        r = data["requests"].get(rid)
        if not r:
            return bot.answer_callback_query(c.id, "Нет заявки", show_alert=True)
        if r["status"] != "wait":
            return bot.answer_callback_query(c.id, "Уже обработано", show_alert=True)
        r["status"] = "paid" if action == "paid" else "rejected"
        save_data(data)
    if action == "paid":
        bot.send_message(r["user_id"], f"✅ Заявка #{rid} выплачена.\n\nСпасибо за обмен 💛")
    else:
        bot.send_message(r["user_id"], f"❌ Заявка #{rid} отклонена. Напишите в поддержку.")
    try: bot.edit_message_reply_markup(c.message.chat.id, c.message.message_id, reply_markup=None)
    except Exception: pass
    bot.answer_callback_query(c.id, "Готово")

@bot.message_handler(func=lambda m: m.text == "📊 Курс")
def rate(m):
    bot.send_message(m.chat.id, "📊 <b>Курс обмена</b>\n\n⭐ 50 Stars → 15 грн\n⭐ 100 Stars → 28 грн 33 коп\n\n⏳ Выплаты 1 раз в день вечером.")

@bot.message_handler(func=lambda m: m.text == "❓ FAQ")
def faq(m):
    bot.send_message(m.chat.id,
        "❓ <b>FAQ</b>\n\n"
        "• Как обменять? Выберите сумму, укажите карту, отправьте Stars подарком и пришлите скрин.\n\n"
        f"• Куда отправлять Stars? Подарком пользователю {SUPPORT}.\n\n"
        "• Когда выплата? Вечером, до 24 часов.\n\n"
        "• Минимум? 50 Stars.")

@bot.message_handler(func=lambda m: m.text == "🛠 Поддержка")
def support(m):
    bot.send_message(m.chat.id, f"🛠 Поддержка: {SUPPORT}")

@bot.message_handler(func=lambda m: m.text == "⭐ Отзывы")
def reviews(m):
    bot.send_message(m.chat.id, "⭐ Отзывов пока нет.")

@bot.message_handler(func=lambda m: m.text == "📋 Мои заявки")
def my_req(m):
    uid = str(m.from_user.id)
    data = load_data()
    items = [(rid, r) for rid, r in data["requests"].items() if r["user_id"] == uid]
    if not items:
        return bot.send_message(m.chat.id, "📋 У вас пока нет заявок.")
    txt = "📋 <b>Ваши заявки</b>\n\n"
    st = {"wait": "⏳ На проверке", "paid": "✅ Выплачено", "rejected": "❌ Отклонено"}
    for rid, r in sorted(items, key=lambda x: int(x[0]), reverse=True)[:10]:
        txt += f"№{rid} — {r['stars']} ⭐ → {r['uah']}\nСтатус: {st.get(r['status'], r['status'])}\n\n"
    bot.send_message(m.chat.id, txt)

@bot.message_handler(commands=["requests"])
def requests(m):
    if m.from_user.id != ADMIN_ID: return
    data = load_data()
    wait = [(rid, r) for rid, r in data["requests"].items() if r["status"] == "wait"]
    if not wait: return bot.send_message(m.chat.id, "📭 Новых заявок нет.")
    for rid, r in wait[:20]:
        bot.send_message(m.chat.id,
            f"⭐ Заявка #{rid}\n@{r.get('username') or 'нет'}\nID: <code>{r['user_id']}</code>\n"
            f"{r['stars']} Stars → {r['uah']}\nКарта: <code>{r['card']}</code>",
            reply_markup=admin_kb(rid))

@bot.message_handler(commands=["stats"])
def stats(m):
    if m.from_user.id != ADMIN_ID: return
    data = load_data()
    wait = sum(1 for r in data["requests"].values() if r["status"] == "wait")
    paid = sum(1 for r in data["requests"].values() if r["status"] == "paid")
    bot.send_message(m.chat.id, f"📊 Статистика\n\n👥 Пользователей: {len(data['users'])}\n⏳ На проверке: {wait}\n✅ Выплачено: {paid}")

@bot.message_handler(commands=["send"])
def send_all(m):
    if m.from_user.id != ADMIN_ID: return
    text = m.text.replace("/send", "", 1).strip()
    if not text: return bot.send_message(m.chat.id, "Использование: /send текст")
    data = load_data()
    ok = bad = 0
    for uid in list(data["users"].keys()):
        try:
            bot.send_message(uid, text); ok += 1; time.sleep(0.03)
        except Exception:
            bad += 1
    bot.send_message(m.chat.id, f"✅ Рассылка завершена.\nОтправлено: {ok}\nОшибок: {bad}")

@bot.message_handler(commands=["exchangeoff"])
def off(m):
    if m.from_user.id != ADMIN_ID: return
    data = load_data(); data["settings"]["exchange_enabled"] = False; save_data(data)
    bot.send_message(m.chat.id, "✅ Обмен отключён.")

@bot.message_handler(commands=["exchangeon"])
def on(m):
    if m.from_user.id != ADMIN_ID: return
    data = load_data(); data["settings"]["exchange_enabled"] = True; save_data(data)
    bot.send_message(m.chat.id, "✅ Обмен включён.")

@bot.message_handler(func=lambda m: True)
def text_router(m):
    with LOCK:
        data = load_data()
        u = get_user(data, m.from_user.id, m.from_user.username or "")
        if u.get("state") == "card":
            text = (m.text or "").strip()
            if len(text) < 8:
                return bot.send_message(m.chat.id, "❌ Напишите нормальную карту/реквизиты.")
            u["card"] = text
            u["state"] = "screen"
            pack = PACKS[u["pack"]]
            save_data(data)
            return bot.send_message(m.chat.id,
                f"✅ Почти готово\n\n⭐ Сумма: <b>{pack['stars']} Stars</b>\n"
                f"💸 К выплате: <b>{pack['uah']}</b>\n\n"
                f"🎁 Отправьте Stars подарком пользователю: <b>{SUPPORT}</b>\n\n"
                "📸 После отправки пришлите скриншот подарка сюда.")
    bot.send_message(m.chat.id, "👇 Выберите действие в меню.", reply_markup=main_menu())

app = Flask(__name__)
@app.route("/")
def home(): return "Stars Exchange Bot is working ✅"

def web():
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 10000)))

if __name__ == "__main__":
    threading.Thread(target=web, daemon=True).start()
    bot.infinity_polling(skip_pending=True)
