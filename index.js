const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не найден");

const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

const BOT_USERNAME = process.env.BOT_USERNAME || "YOUR_BOT_USERNAME";

/*
  =========================
  ХРАНЕНИЕ ИГР В ПАМЯТИ
  =========================
*/

const lobbies = new Map(); // chatId -> lobby
const playerToLobby = new Map(); // userId -> chatId

function getDisplayName(user) {
  if (!user) return "Игрок";
  if (user.username) return `@${user.username}`;
  const full = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return full || `id${user.id}`;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function roleDescription(role) {
  switch (role) {
    case "infected":
      return "🦠 Ты заражённый.\nНочью ты выбираешь, кого заразить.";
    case "doctor":
      return "💉 Ты врач.\nНочью ты выбираешь, кого лечить.";
    case "scanner":
      return "🔎 Ты сканер.\nНочью ты проверяешь, заражён ли игрок.";
    case "guard":
      return "🛡 Ты охранник.\nНочью ты защищаешь одного игрока.";
    default:
      return "🙂 Ты мирный.\nДнём голосуй и ищи заражённых.";
  }
}

function getAlivePlayers(lobby) {
  return lobby.players.filter((p) => p.alive);
}

function getAliveNonInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role !== "infected");
}

function getAliveInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role === "infected");
}

function findPlayer(lobby, userId) {
  return lobby.players.find((p) => String(p.id) === String(userId));
}

function isCreator(lobby, userId) {
  return String(lobby.creatorId) === String(userId);
}

function buildLobbyText(lobby) {
  const list = lobby.players
    .map((p, i) => `${i + 1}. ${p.name}`)
    .join("\n");

  return (
    `🧪 *Лобби "Заражение"*\n\n` +
    `Создатель: ${lobby.creatorName}\n\n` +
    `*Игроки:*\n${list}\n\n` +
    `Для входа нажми кнопку *Играть* ниже.\n` +
    `После этого бот добавит тебя в список игроков.`
  );
}

function buildLobbyKeyboard(lobby) {
  return {
    inline_keyboard: [
      [
        {
          text: "🎮 Играть",
          url: `https://t.me/${BOT_USERNAME}?start=join_${lobby.chatId}`
        }
      ]
    ]
  };
}

function getRolesForCount(count) {
  if (count < 5) return null;

  if (count === 5) {
    return ["infected", "doctor", "scanner", "civilian", "civilian"];
  }

  if (count === 6) {
    return ["infected", "doctor", "scanner", "guard", "civilian", "civilian"];
  }

  if (count === 7) {
    return ["infected", "infected", "doctor", "scanner", "guard", "civilian", "civilian"];
  }

  return ["infected", "infected", "doctor", "scanner", "guard", "civilian", "civilian", "civilian"];
}

async function renderLobbyMessage(lobby) {
  if (!lobby.lobbyMessageId) return;
  try {
    await bot.editMessageText(buildLobbyText(lobby), {
      chat_id: lobby.chatId,
      message_id: lobby.lobbyMessageId,
      parse_mode: "Markdown",
      reply_markup: buildLobbyKeyboard(lobby)
    });
  } catch (e) {
    console.log("Не удалось обновить лобби:", e.message);
  }
}

async function sendRoleToPlayer(player) {
  try {
    await bot.sendMessage(player.id, roleDescription(player.role));
  } catch (e) {
    console.log(`Не удалось отправить роль ${player.id}:`, e.message);
  }
}

function createNightTargetsKeyboard(lobby, actorId, action) {
  const actor = findPlayer(lobby, actorId);
  if (!actor || !actor.alive) return { inline_keyboard: [] };

  let targets = getAlivePlayers(lobby).filter((p) => p.id !== actor.id);

  if (action === "scan") {
    targets = getAlivePlayers(lobby).filter((p) => p.id !== actor.id);
  }

  return {
    inline_keyboard: targets.map((p) => [
      {
        text: p.name,
        callback_data: `night:${action}:${lobby.chatId}:${p.id}`
      }
    ])
  };
}

async function startNight(lobby) {
  lobby.phase = "night";
  lobby.nightActions = {
    infected: [],
    doctor: null,
    scanner: null,
    guard: null
  };

  const alive = getAlivePlayers(lobby);

  await bot.sendMessage(
    lobby.chatId,
    `🌙 *Ночь ${lobby.round}*\n\nНочные роли, проверьте личные сообщения с ботом.`,
    { parse_mode: "Markdown" }
  );

  for (const player of alive) {
    try {
      if (player.role === "infected") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого заразить:`,
          { reply_markup: createNightTargetsKeyboard(lobby, player.id, "infect") }
        );
      } else if (player.role === "doctor") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого лечить:`,
          { reply_markup: createNightTargetsKeyboard(lobby, player.id, "heal") }
        );
      } else if (player.role === "scanner") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого проверить:`,
          { reply_markup: createNightTargetsKeyboard(lobby, player.id, "scan") }
        );
      } else if (player.role === "guard") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого защитить:`,
          { reply_markup: createNightTargetsKeyboard(lobby, player.id, "guard") }
        );
      }
    } catch (e) {
      console.log("Ошибка отправки ночного действия:", e.message);
    }
  }

  maybeFinishNight(lobby);
}

function allNightActionsDone(lobby) {
  const alive = getAlivePlayers(lobby);

  const infectedAlive = alive.filter((p) => p.role === "infected").length;
  const doctorAlive = alive.some((p) => p.role === "doctor");
  const scannerAlive = alive.some((p) => p.role === "scanner");
  const guardAlive = alive.some((p) => p.role === "guard");

  const infectedDone = lobby.nightActions.infected.length >= infectedAlive;
  const doctorDone = !doctorAlive || lobby.nightActions.doctor !== null;
  const scannerDone = !scannerAlive || lobby.nightActions.scanner !== null;
  const guardDone = !guardAlive || lobby.nightActions.guard !== null;

  return infectedDone && doctorDone && scannerDone && guardDone;
}

async function maybeFinishNight(lobby) {
  if (!allNightActionsDone(lobby)) return;
  await finishNight(lobby);
}

async function finishNight(lobby) {
  if (lobby.phase !== "night") return;

  const infectedTargets = lobby.nightActions.infected;
  const doctorTarget = lobby.nightActions.doctor;
  const scannerTarget = lobby.nightActions.scanner;
  const guardTarget = lobby.nightActions.guard;

  let infectedVictimId = null;

  if (infectedTargets.length > 0) {
    const counts = {};
    for (const id of infectedTargets) {
      counts[id] = (counts[id] || 0) + 1;
    }

    let maxVotes = 0;
    for (const [id, votes] of Object.entries(counts)) {
      if (votes > maxVotes) {
        maxVotes = votes;
        infectedVictimId = Number(id);
      }
    }
  }

  let dayText = `☀ *День ${lobby.round}*\n\n`;

  if (scannerTarget) {
    const scannedPlayer = findPlayer(lobby, scannerTarget);
    const scanner = getAlivePlayers(lobby).find((p) => p.role === "scanner");
    if (scanner && scannedPlayer) {
      try {
        await bot.sendMessage(
          scanner.id,
          scannedPlayer.role === "infected"
            ? `🔎 Проверка: ${scannedPlayer.name} — заражённый.`
            : `🔎 Проверка: ${scannedPlayer.name} — не заражённый.`
        );
      } catch (e) {
        console.log("Ошибка отправки проверки сканеру:", e.message);
      }
    }
  }

  if (!infectedVictimId) {
    dayText += `Ночью ничего не произошло.\n`;
  } else if (
    Number(infectedVictimId) === Number(doctorTarget) ||
    Number(infectedVictimId) === Number(guardTarget)
  ) {
    const saved = findPlayer(lobby, infectedVictimId);
    dayText += `Ночью попытка заражения была остановлена.\n`;
    if (saved) {
      dayText += `${saved.name} удалось спасти.\n`;
    }
  } else {
    const victim = findPlayer(lobby, infectedVictimId);
    if (victim && victim.alive && victim.role !== "infected") {
      victim.role = "infected";
      dayText += `Ночью был заражён игрок: ${victim.name}\n`;
      try {
        await bot.sendMessage(
          victim.id,
          `🦠 Ты был заражён этой ночью.\nТеперь ты заражённый.\nСледующей ночью ты тоже будешь делать ход.`
        );
      } catch (e) {
        console.log("Не удалось сообщить о заражении:", e.message);
      }
    } else {
      dayText += `Ночью ничего не произошло.\n`;
    }
  }

  await bot.sendMessage(lobby.chatId, dayText, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  await startVoting(lobby);
}

async function startVoting(lobby) {
  lobby.phase = "voting";
  lobby.votes = {};

  const alive = getAlivePlayers(lobby);

  const keyboard = {
    inline_keyboard: [
      ...alive.map((p) => [
        {
          text: p.name,
          callback_data: `vote:${lobby.chatId}:${p.id}`
        }
      ]),
      [
        {
          text: "⏭ Пропуск",
          callback_data: `vote:${lobby.chatId}:skip`
        }
      ]
    ]
  };

  const msg = await bot.sendMessage(
    lobby.chatId,
    `🗳 *Голосование*\n\nВыберите, кого изгнать.`,
    {
      parse_mode: "Markdown",
      reply_markup: keyboard
    }
  );

  lobby.voteMessageId = msg.message_id;
}

function allAliveVoted(lobby) {
  const alive = getAlivePlayers(lobby);
  return alive.every((p) => lobby.votes[p.id] !== undefined);
}

async function finishVoting(lobby) {
  if (lobby.phase !== "voting") return;

  const voteCounts = {};
  for (const voterId of Object.keys(lobby.votes)) {
    const target = lobby.votes[voterId];
    voteCounts[target] = (voteCounts[target] || 0) + 1;
  }

  let topTarget = null;
  let topVotes = 0;
  let tie = false;

  for (const [target, count] of Object.entries(voteCounts)) {
    if (count > topVotes) {
      topVotes = count;
      topTarget = target;
      tie = false;
    } else if (count === topVotes) {
      tie = true;
    }
  }

  let resultText = `🗳 *Голосование окончено*\n\n`;

  if (!topTarget || tie || topTarget === "skip") {
    resultText += `Никто не был изгнан.`;
  } else {
    const player = findPlayer(lobby, Number(topTarget));
    if (player && player.alive) {
      player.alive = false;
      resultText += `Изгнан игрок: ${player.name}\nРоль: *${roleNameRu(player.role)}*`;
    } else {
      resultText += `Никто не был изгнан.`;
    }
  }

  await bot.sendMessage(lobby.chatId, resultText, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  lobby.round += 1;
  await startNight(lobby);
}

function roleNameRu(role) {
  switch (role) {
    case "infected":
      return "Заражённый";
    case "doctor":
      return "Врач";
    case "scanner":
      return "Сканер";
    case "guard":
      return "Охранник";
    default:
      return "Мирный";
  }
}

function checkWinner(lobby) {
  const infectedAlive = getAliveInfected(lobby).length;
  const nonInfectedAlive = getAliveNonInfected(lobby).length;

  if (infectedAlive === 0) return "civilian";
  if (infectedAlive >= nonInfectedAlive) return "infected";

  return null;
}

async function finishGame(lobby, winner) {
  lobby.phase = "ended";

  const text =
    winner === "infected"
      ? `🦠 *Победа заражённых!*\nОни захватили группу.`
      : `🙂 *Победа мирных!*\nВсе заражённые найдены.`;

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });

  for (const p of lobby.players) {
    playerToLobby.delete(String(p.id));
  }
  lobbies.delete(String(lobby.chatId));
}

/*
  =========================
  КОМАНДЫ
  =========================
*/

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const payload = match && match[1] ? match[1].trim() : "";

  if (msg.chat.type !== "private") {
    await bot.sendMessage(chatId, "Напиши мне в личку, чтобы играть.");
    return;
  }

  if (!payload) {
    await bot.sendMessage(
      chatId,
      `Привет, ${getDisplayName(user)}!\n\nЕсли тебя пригласили в игру, зайди по кнопке из группы ещё раз.`
    );
    return;
  }

  if (payload.startsWith("join_")) {
    const groupChatId = payload.replace("join_", "");
    const lobby = lobbies.get(String(groupChatId));

    if (!lobby) {
      await bot.sendMessage(chatId, "Лобби не найдено или игра уже началась.");
      return;
    }

    if (lobby.started) {
      await bot.sendMessage(chatId, "Игра уже началась.");
      return;
    }

    const existing = findPlayer(lobby, user.id);
    if (existing) {
      await bot.sendMessage(chatId, "Ты уже в игре.");
      return;
    }

    if (lobby.players.length >= 8) {
      await bot.sendMessage(chatId, "Лобби уже заполнено.");
      return;
    }

    const player = {
      id: user.id,
      name: getDisplayName(user),
      alive: true,
      role: null
    };

    lobby.players.push(player);
    playerToLobby.set(String(user.id), String(groupChatId));

    await bot.sendMessage(chatId, `✅ Ты добавлен в игру в группе.\nТвой ник: ${player.name}`);
    await renderLobbyMessage(lobby);
    return;
  }

  await bot.sendMessage(chatId, "Неизвестная команда запуска.");
});

bot.onText(/^\/create_game$/, async (msg) => {
  if (msg.chat.type === "private") {
    await bot.sendMessage(msg.chat.id, "Эту команду надо писать в группе.");
    return;
  }

  const chatId = String(msg.chat.id);

  if (lobbies.has(chatId)) {
    await bot.sendMessage(msg.chat.id, "В этой группе уже есть активная игра.");
    return;
  }

  const creator = msg.from;
  const lobby = {
    chatId,
    creatorId: creator.id,
    creatorName: getDisplayName(creator),
    players: [
      {
        id: creator.id,
        name: getDisplayName(creator),
        alive: true,
        role: null
      }
    ],
    started: false,
    phase: "lobby",
    round: 1,
    nightActions: null,
    votes: {},
    lobbyMessageId: null,
    voteMessageId: null
  };

  lobbies.set(chatId, lobby);
  playerToLobby.set(String(creator.id), chatId);

  const sent = await bot.sendMessage(msg.chat.id, buildLobbyText(lobby), {
    parse_mode: "Markdown",
    reply_markup: buildLobbyKeyboard(lobby)
  });

  lobby.lobbyMessageId = sent.message_id;
});

bot.onText(/^\/startgame$/, async (msg) => {
  if (msg.chat.type === "private") {
    await bot.sendMessage(msg.chat.id, "Эту команду надо писать в группе.");
    return;
  }

  const chatId = String(msg.chat.id);
  const lobby = lobbies.get(chatId);

  if (!lobby) {
    await bot.sendMessage(msg.chat.id, "Сначала создай игру через /create_game");
    return;
  }

  if (!isCreator(lobby, msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Начать игру может только создатель.");
    return;
  }

  if (lobby.started) {
    await bot.sendMessage(msg.chat.id, "Игра уже началась.");
    return;
  }

  const roles = getRolesForCount(lobby.players.length);
  if (!roles) {
    await bot.sendMessage(msg.chat.id, "Нужно минимум 5 игроков.");
    return;
  }

  lobby.started = true;

  const shuffledPlayers = shuffle(lobby.players);
  const shuffledRoles = shuffle(roles);

  for (let i = 0; i < shuffledPlayers.length; i++) {
    shuffledPlayers[i].role = shuffledRoles[i] || "civilian";
  }

  await bot.sendMessage(
    msg.chat.id,
    `🎮 *Игра началась!*\n\nИгроков: ${lobby.players.length}\nРоли розданы в личные сообщения.`,
    { parse_mode: "Markdown" }
  );

  for (const player of lobby.players) {
    await sendRoleToPlayer(player);
  }

  await startNight(lobby);
});

bot.onText(/^\/cancel_game$/, async (msg) => {
  const chatId = String(msg.chat.id);
  const lobby = lobbies.get(chatId);

  if (!lobby) {
    await bot.sendMessage(msg.chat.id, "Активной игры нет.");
    return;
  }

  if (!isCreator(lobby, msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Отменить игру может только создатель.");
    return;
  }

  for (const p of lobby.players) {
    playerToLobby.delete(String(p.id));
  }
  lobbies.delete(chatId);

  await bot.sendMessage(msg.chat.id, "Игра отменена.");
});

/*
  =========================
  CALLBACK QUERY
  =========================
*/

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const fromId = query.from.id;

    if (data.startsWith("night:")) {
      const [, action, lobbyChatId, targetIdRaw] = data.split(":");
      const lobby = lobbies.get(String(lobbyChatId));

      if (!lobby || lobby.phase !== "night") {
        await bot.answerCallbackQuery(query.id, { text: "Ночь уже закончилась." });
        return;
      }

      const actor = findPlayer(lobby, fromId);
      const targetId = Number(targetIdRaw);
      const target = findPlayer(lobby, targetId);

      if (!actor || !actor.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не участвуешь в игре." });
        return;
      }

      if (!target || !target.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Игрок недоступен." });
        return;
      }

      if (action === "infect") {
        if (actor.role !== "infected") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }

        const already = lobby.nightActions.infectedActorMap || {};
        if (already[String(actor.id)]) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        already[String(actor.id)] = targetId;
        lobby.nightActions.infectedActorMap = already;
        lobby.nightActions.infected.push(targetId);

        await bot.answerCallbackQuery(query.id, { text: `Ты выбрал: ${target.name}` });
        await bot.sendMessage(actor.id, `🦠 Ты выбрал игрока ${target.name}`);
      }

      if (action === "heal") {
        if (actor.role !== "doctor") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.doctor !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        lobby.nightActions.doctor = targetId;
        await bot.answerCallbackQuery(query.id, { text: `Ты лечишь: ${target.name}` });
        await bot.sendMessage(actor.id, `💉 Ты лечишь игрока ${target.name}`);
      }

      if (action === "scan") {
        if (actor.role !== "scanner") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.scanner !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        lobby.nightActions.scanner = targetId;
        await bot.answerCallbackQuery(query.id, { text: `Ты проверяешь: ${target.name}` });
        await bot.sendMessage(actor.id, `🔎 Ты проверяешь игрока ${target.name}`);
      }

      if (action === "guard") {
        if (actor.role !== "guard") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }
        if (lobby.nightActions.guard !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        lobby.nightActions.guard = targetId;
        await bot.answerCallbackQuery(query.id, { text: `Ты защищаешь: ${target.name}` });
        await bot.sendMessage(actor.id, `🛡 Ты защищаешь игрока ${target.name}`);
      }

      await maybeFinishNight(lobby);
      return;
    }

    if (data.startsWith("vote:")) {
      const [, lobbyChatId, targetRaw] = data.split(":");
      const lobby = lobbies.get(String(lobbyChatId));

      if (!lobby || lobby.phase !== "voting") {
        await bot.answerCallbackQuery(query.id, { text: "Голосование уже окончено." });
        return;
      }

      const voter = findPlayer(lobby, fromId);
      if (!voter || !voter.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не можешь голосовать." });
        return;
      }

      if (lobby.votes[voter.id] !== undefined) {
        await bot.answerCallbackQuery(query.id, { text: "Ты уже проголосовал." });
        return;
      }

      if (targetRaw === "skip") {
        lobby.votes[voter.id] = "skip";
        await bot.answerCallbackQuery(query.id, { text: "Ты выбрал пропуск." });
      } else {
        const target = findPlayer(lobby, Number(targetRaw));
        if (!target || !target.alive) {
          await bot.answerCallbackQuery(query.id, { text: "Этот игрок уже недоступен." });
          return;
        }

        lobby.votes[voter.id] = Number(targetRaw);
        await bot.answerCallbackQuery(query.id, { text: `Ты голосуешь против ${target.name}` });
      }

      if (allAliveVoted(lobby)) {
        await finishVoting(lobby);
      }

      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (e) {
    console.log("Ошибка callback_query:", e.message);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Произошла ошибка." });
    } catch {}
  }
});

/*
  =========================
  ДОПОЛНИТЕЛЬНО
  =========================
*/

bot.on("polling_error", (err) => {
  console.log("Polling error:", err.message);
});

bot.on("message", async (msg) => {
  if (!msg.text) return;

  if (
    msg.text.startsWith("/start") ||
    msg.text === "/create_game" ||
    msg.text === "/startgame" ||
    msg.text === "/cancel_game"
  ) {
    return;
  }
});
