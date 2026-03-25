const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("BOT_TOKEN не найден");

const BOT_USERNAME = "zaraenik_bot";

const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (_, res) => {
  res.send("Bot is running");
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

const lobbies = new Map();

function getDisplayName(user) {
  if (!user) return "Игрок";
  if (user.username) return `@${user.username}`;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || `id${user.id}`;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getLobby(chatId) {
  return lobbies.get(String(chatId));
}

function getPlayer(lobby, userId) {
  return lobby.players.find((p) => String(p.id) === String(userId));
}

function getAlivePlayers(lobby) {
  return lobby.players.filter((p) => p.alive);
}

function getAliveInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role === "infected");
}

function getAliveNonInfected(lobby) {
  return lobby.players.filter((p) => p.alive && p.role !== "infected");
}

function isCreator(lobby, userId) {
  return String(lobby.creatorId) === String(userId);
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

function roleDescription(role) {
  switch (role) {
    case "infected":
      return "🦠 Твоя роль: Заражённый\n\nНочью ты выбираешь, кого заразить.";
    case "doctor":
      return "💉 Твоя роль: Врач\n\nНочью ты выбираешь, кого лечить.";
    case "scanner":
      return "🔎 Твоя роль: Сканер\n\nНочью ты проверяешь одного игрока.";
    case "guard":
      return "🛡 Твоя роль: Охранник\n\nНочью ты защищаешь одного игрока.";
    default:
      return "🙂 Твоя роль: Мирный\n\nДнём голосуй и ищи заражённых.";
  }
}

function getJoinLink(lobby) {
  return `https://t.me/${BOT_USERNAME}?start=join_${lobby.chatId}`;
}

function buildLobbyText(lobby) {
  const playersText = lobby.players
    .map((p, index) => `${index + 1}. ${p.name}`)
    .join("\n");

  const joinLink = getJoinLink(lobby);

  return (
    `🧪 *Лобби "Заражение"*\n\n` +
    `Создатель: ${lobby.creatorName}\n\n` +
    `*Игроки:*\n${playersText}\n\n` +
    `Ссылка для входа:\n${joinLink}\n\n` +
    `Нажми кнопку *Играть* ниже или перейди по ссылке.\n` +
    `После нажатия *Start* бот автоматически добавит тебя в список игроков.`
  );
}

function buildLobbyKeyboard(lobby) {
  return {
    inline_keyboard: [
      [
        {
          text: "🎮 Играть",
          url: getJoinLink(lobby)
        }
      ]
    ]
  };
}

async function renderLobbyMessage(lobby) {
  if (!lobby.lobbyMessageId) return;

  try {
    await bot.editMessageText(buildLobbyText(lobby), {
      chat_id: lobby.chatId,
      message_id: lobby.lobbyMessageId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buildLobbyKeyboard(lobby)
    });
  } catch (error) {
    console.log("Ошибка обновления лобби:", error.message);
  }
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

async function sendRole(player) {
  try {
    await bot.sendMessage(player.id, roleDescription(player.role));
  } catch (error) {
    console.log(`Не удалось отправить роль игроку ${player.id}:`, error.message);
  }
}

function checkWinner(lobby) {
  const infected = getAliveInfected(lobby).length;
  const nonInfected = getAliveNonInfected(lobby).length;

  if (infected === 0) return "civilian";
  if (infected >= nonInfected) return "infected";

  return null;
}

async function finishGame(lobby, winner) {
  lobby.phase = "ended";

  const text =
    winner === "infected"
      ? `🦠 *Победа заражённых!*\n\nОни захватили всех.`
      : `🙂 *Победа мирных!*\n\nВсе заражённые найдены.`;

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });
  lobbies.delete(String(lobby.chatId));
}

function createNightKeyboard(lobby, actorId, action) {
  const alivePlayers = getAlivePlayers(lobby).filter((p) => String(p.id) !== String(actorId));

  return {
    inline_keyboard: alivePlayers.map((p) => [
      {
        text: p.name,
        callback_data: `night:${action}:${lobby.chatId}:${p.id}`
      }
    ])
  };
}

function allNightActionsDone(lobby) {
  const alivePlayers = getAlivePlayers(lobby);

  const infectedAlive = alivePlayers.filter((p) => p.role === "infected").length;
  const doctorAlive = alivePlayers.some((p) => p.role === "doctor");
  const scannerAlive = alivePlayers.some((p) => p.role === "scanner");
  const guardAlive = alivePlayers.some((p) => p.role === "guard");

  const infectedDone = Object.keys(lobby.nightActions.infectedByActor).length >= infectedAlive;
  const doctorDone = !doctorAlive || lobby.nightActions.doctor !== null;
  const scannerDone = !scannerAlive || lobby.nightActions.scanner !== null;
  const guardDone = !guardAlive || lobby.nightActions.guard !== null;

  return infectedDone && doctorDone && scannerDone && guardDone;
}

async function maybeFinishNight(lobby) {
  if (!allNightActionsDone(lobby)) return;
  await finishNight(lobby);
}

async function startNight(lobby) {
  lobby.phase = "night";
  lobby.nightActions = {
    infectedByActor: {},
    doctor: null,
    scanner: null,
    guard: null
  };

  await bot.sendMessage(
    lobby.chatId,
    `🌙 *Ночь ${lobby.round}*\n\nНочные роли, проверьте личные сообщения.`,
    { parse_mode: "Markdown" }
  );

  for (const player of getAlivePlayers(lobby)) {
    try {
      if (player.role === "infected") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого заразить:`,
          { reply_markup: createNightKeyboard(lobby, player.id, "infect") }
        );
      } else if (player.role === "doctor") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого лечить:`,
          { reply_markup: createNightKeyboard(lobby, player.id, "heal") }
        );
      } else if (player.role === "scanner") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого проверить:`,
          { reply_markup: createNightKeyboard(lobby, player.id, "scan") }
        );
      } else if (player.role === "guard") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${lobby.round}\nВыбери, кого защитить:`,
          { reply_markup: createNightKeyboard(lobby, player.id, "guard") }
        );
      }
    } catch (error) {
      console.log("Ошибка отправки ночного действия:", error.message);
    }
  }

  await maybeFinishNight(lobby);
}

async function finishNight(lobby) {
  if (lobby.phase !== "night") return;

  const infectedChoices = Object.values(lobby.nightActions.infectedByActor);
  const doctorTarget = lobby.nightActions.doctor;
  const scannerTarget = lobby.nightActions.scanner;
  const guardTarget = lobby.nightActions.guard;

  let finalTarget = null;

  if (infectedChoices.length > 0) {
    const counts = {};
    for (const targetId of infectedChoices) {
      counts[targetId] = (counts[targetId] || 0) + 1;
    }

    let maxVotes = 0;
    let hasTie = false;

    for (const [targetId, votes] of Object.entries(counts)) {
      if (votes > maxVotes) {
        maxVotes = votes;
        finalTarget = String(targetId);
        hasTie = false;
      } else if (votes === maxVotes) {
        hasTie = true;
      }
    }

    if (hasTie) {
      finalTarget = null;
    }
  }

  if (scannerTarget !== null) {
    const scanner = getAlivePlayers(lobby).find((p) => p.role === "scanner");
    const checkedPlayer = getPlayer(lobby, scannerTarget);

    if (scanner && checkedPlayer) {
      try {
        if (checkedPlayer.role === "infected") {
          await bot.sendMessage(scanner.id, `🔎 Проверка: ${checkedPlayer.name} — заражённый.`);
        } else {
          await bot.sendMessage(scanner.id, `🔎 Проверка: ${checkedPlayer.name} — не заражённый.`);
        }
      } catch (error) {
        console.log("Ошибка отправки результата сканеру:", error.message);
      }
    }
  }

  let text = `☀ *День ${lobby.round}*\n\n`;

  if (!finalTarget) {
    text += `Ночью ничего не произошло.`;
  } else if (finalTarget === doctorTarget || finalTarget === guardTarget) {
    const saved = getPlayer(lobby, finalTarget);
    if (saved) {
      text += `Ночью попытка заражения была остановлена.\n${saved.name} удалось спасти.`;
    } else {
      text += `Ночью попытка заражения была остановлена.`;
    }
  } else {
    const victim = getPlayer(lobby, finalTarget);

    if (victim && victim.alive && victim.role !== "infected") {
      victim.role = "infected";
      text += `Ночью был заражён игрок: ${victim.name}`;

      try {
        await bot.sendMessage(
          victim.id,
          `🦠 Ты был заражён.\nТеперь твоя роль — Заражённый.\nСледующей ночью ты сможешь делать ход.`
        );
      } catch (error) {
        console.log("Ошибка отправки заражённому:", error.message);
      }
    } else {
      text += `Ночью ничего не произошло.`;
    }
  }

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  await startVoting(lobby);
}

function buildVotingKeyboard(lobby) {
  const alivePlayers = getAlivePlayers(lobby);

  return {
    inline_keyboard: [
      ...alivePlayers.map((p) => [
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
}

function allAliveVoted(lobby) {
  return getAlivePlayers(lobby).every((p) => lobby.votes[String(p.id)] !== undefined);
}

async function startVoting(lobby) {
  lobby.phase = "voting";
  lobby.votes = {};

  const sent = await bot.sendMessage(
    lobby.chatId,
    `🗳 *Голосование*\n\nВыберите, кого изгнать.`,
    {
      parse_mode: "Markdown",
      reply_markup: buildVotingKeyboard(lobby)
    }
  );

  lobby.voteMessageId = sent.message_id;
}

async function finishVoting(lobby) {
  if (lobby.phase !== "voting") return;

  const counts = {};

  for (const target of Object.values(lobby.votes)) {
    counts[target] = (counts[target] || 0) + 1;
  }

  let maxVotes = 0;
  let selected = null;
  let hasTie = false;

  for (const [target, votes] of Object.entries(counts)) {
    if (votes > maxVotes) {
      maxVotes = votes;
      selected = target;
      hasTie = false;
    } else if (votes === maxVotes) {
      hasTie = true;
    }
  }

  let text = `🗳 *Голосование окончено*\n\n`;

  if (!selected || hasTie || selected === "skip") {
    text += `Никто не был изгнан.`;
  } else {
    const player = getPlayer(lobby, selected);

    if (player && player.alive) {
      player.alive = false;
      text += `Изгнан игрок: ${player.name}\nРоль: *${roleNameRu(player.role)}*`;
    } else {
      text += `Никто не был изгнан.`;
    }
  }

  await bot.sendMessage(lobby.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(lobby);
  if (winner) {
    await finishGame(lobby, winner);
    return;
  }

  lobby.round += 1;
  await startNight(lobby);
}

async function addUserToLobby(user, lobbyChatId) {
  const lobby = getLobby(lobbyChatId);

  if (!lobby) {
    return { ok: false, text: "Лобби не найдено или игра уже закончилась." };
  }

  if (lobby.started) {
    return { ok: false, text: "Игра уже началась. Войти нельзя." };
  }

  if (lobby.players.length >= 8) {
    return { ok: false, text: "Лобби уже заполнено." };
  }

  const already = getPlayer(lobby, user.id);
  if (already) {
    return { ok: true, text: "Ты уже есть в этом лобби." };
  }

  const player = {
    id: user.id,
    name: getDisplayName(user),
    alive: true,
    role: null
  };

  lobby.players.push(player);

  await renderLobbyMessage(lobby);

  try {
    await bot.sendMessage(
      lobby.chatId,
      `➕ В игру вошёл игрок: ${player.name}\nТеперь игроков: ${lobby.players.length}`
    );
  } catch (error) {
    console.log("Ошибка сообщения о входе:", error.message);
  }

  return { ok: true, text: `✅ Ты добавлен в игру.\nТвой ник: ${player.name}` };
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const payload = match && match[1] ? match[1].trim() : "";

  if (msg.chat.type !== "private") {
    await bot.sendMessage(chatId, "Напиши мне в личку.");
    return;
  }

  if (payload.startsWith("join_")) {
    const lobbyChatId = payload.replace("join_", "");
    const result = await addUserToLobby(user, lobbyChatId);
    await bot.sendMessage(chatId, result.text);
    return;
  }

  await bot.sendMessage(
    chatId,
    `Привет, ${getDisplayName(user)}!\n\nНажми кнопку *Играть* в группе или открой ссылку из лобби.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/create_game$/, async (msg) => {
  if (msg.chat.type === "private") {
    await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
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

  const sent = await bot.sendMessage(msg.chat.id, buildLobbyText(lobby), {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buildLobbyKeyboard(lobby)
  });

  lobby.lobbyMessageId = sent.message_id;
});

bot.onText(/^\/startgame$/, async (msg) => {
  if (msg.chat.type === "private") {
    await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
    return;
  }

  const lobby = getLobby(msg.chat.id);

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
    await bot.sendMessage(msg.chat.id, "Для старта нужно минимум 5 игроков.");
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
    `🎮 *Игра началась!*\n\nИгроков: ${lobby.players.length}\nРоли отправлены в личные сообщения.`,
    { parse_mode: "Markdown" }
  );

  for (const player of lobby.players) {
    await sendRole(player);
  }

  await startNight(lobby);
});

bot.onText(/^\/cancel_game$/, async (msg) => {
  const lobby = getLobby(msg.chat.id);

  if (!lobby) {
    await bot.sendMessage(msg.chat.id, "Активной игры нет.");
    return;
  }

  if (!isCreator(lobby, msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Отменить игру может только создатель.");
    return;
  }

  lobbies.delete(String(msg.chat.id));
  await bot.sendMessage(msg.chat.id, "Игра отменена.");
});

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const fromId = String(query.from.id);

    if (data.startsWith("night:")) {
      const [, action, lobbyChatId, targetId] = data.split(":");
      const lobby = getLobby(lobbyChatId);

      if (!lobby || lobby.phase !== "night") {
        await bot.answerCallbackQuery(query.id, { text: "Ночь уже закончилась." });
        return;
      }

      const actor = getPlayer(lobby, fromId);
      const target = getPlayer(lobby, targetId);

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

        if (lobby.nightActions.infectedByActor[fromId]) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        lobby.nightActions.infectedByActor[fromId] = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты выбрал ${target.name}` });
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

        lobby.nightActions.doctor = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты лечишь ${target.name}` });
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

        lobby.nightActions.scanner = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты проверяешь ${target.name}` });
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

        lobby.nightActions.guard = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты защищаешь ${target.name}` });
        await bot.sendMessage(actor.id, `🛡 Ты защищаешь игрока ${target.name}`);
      }

      await maybeFinishNight(lobby);
      return;
    }

    if (data.startsWith("vote:")) {
      const [, lobbyChatId, targetId] = data.split(":");
      const lobby = getLobby(lobbyChatId);

      if (!lobby || lobby.phase !== "voting") {
        await bot.answerCallbackQuery(query.id, { text: "Голосование уже окончено." });
        return;
      }

      const voter = getPlayer(lobby, fromId);

      if (!voter || !voter.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не можешь голосовать." });
        return;
      }

      if (lobby.votes[fromId] !== undefined) {
        await bot.answerCallbackQuery(query.id, { text: "Ты уже проголосовал." });
        return;
      }

      if (targetId === "skip") {
        lobby.votes[fromId] = "skip";
        await bot.answerCallbackQuery(query.id, { text: "Ты выбрал пропуск." });
      } else {
        const target = getPlayer(lobby, targetId);

        if (!target || !target.alive) {
          await bot.answerCallbackQuery(query.id, { text: "Этот игрок уже недоступен." });
          return;
        }

        lobby.votes[fromId] = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты голосуешь против ${target.name}` });
      }

      if (allAliveVoted(lobby)) {
        await finishVoting(lobby);
      }

      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.log("Ошибка callback_query:", error.message);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Ошибка." });
    } catch {}
  }
});

bot.on("polling_error", (error) => {
  console.log("Polling error:", error.message);
});
