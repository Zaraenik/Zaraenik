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

const games = new Map();
const profiles = new Map();

function getProfile(userId, fallbackName = "Игрок") {
  const key = String(userId);
  if (!profiles.has(key)) {
    profiles.set(key, {
      userId: key,
      name: fallbackName,
      coins: 0,
      games: 0,
      wins: 0,
      survived: 0
    });
  }
  return profiles.get(key);
}

function updateProfileName(userId, name) {
  const profile = getProfile(userId, name);
  profile.name = name;
  return profile;
}

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

function roleNameRu(role) {
  switch (role) {
    case "infected":
      return "Заражённый";
    case "doctor":
      return "Аптекарь";
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
      return "💊 Твоя роль: Аптекарь\n\nНочью ты выбираешь, кого лечить.";
    case "scanner":
      return "🔎 Твоя роль: Сканер\n\nНочью ты проверяешь одного игрока.";
    case "guard":
      return "🛡 Твоя роль: Охранник\n\nНочью ты защищаешь одного игрока.";
    default:
      return "🙂 Твоя роль: Мирный\n\nДнём голосуй и ищи заражённых.";
  }
}

function getGame(chatId) {
  return games.get(String(chatId));
}

function getPlayer(game, userId) {
  return game.players.find((p) => String(p.id) === String(userId));
}

function getAlivePlayers(game) {
  return game.players.filter((p) => p.alive);
}

function getAliveInfected(game) {
  return game.players.filter((p) => p.alive && p.role === "infected");
}

function getAliveNonInfected(game) {
  return game.players.filter((p) => p.alive && p.role !== "infected");
}

function isCreator(game, userId) {
  return String(game.creatorId) === String(userId);
}

function getJoinLink(game) {
  return `https://t.me/${BOT_USERNAME}?start=join_${game.chatId}`;
}

function buildLobbyText(game) {
  const playersText = game.players.map((p, i) => `${i + 1}. ${p.name}`).join("\n");

  return (
    `🧪 *Лобби "Заражение"*\n\n` +
    `Создатель: ${game.creatorName}\n\n` +
    `*Игроки:*\n${playersText}\n\n` +
    `Ссылка для входа:\n${getJoinLink(game)}\n\n` +
    `Нажми кнопку *Играть* ниже или перейди по ссылке.\n` +
    `После нажатия *Start* бот автоматически добавит тебя в список игроков.\n\n` +
    `Для старта нужно минимум 4 игрока.\n` +
    `Старт игры: /startgame`
  );
}

function buildLobbyKeyboard(game) {
  return {
    inline_keyboard: [
      [
        {
          text: "🎮 Играть",
          url: getJoinLink(game)
        }
      ]
    ]
  };
}

async function renderLobbyMessage(game) {
  if (!game.lobbyMessageId) return;

  try {
    await bot.editMessageText(buildLobbyText(game), {
      chat_id: game.chatId,
      message_id: game.lobbyMessageId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buildLobbyKeyboard(game)
    });
  } catch (error) {
    console.log("Ошибка обновления лобби:", error.message);
  }
}

function getRolesForCount(count) {
  if (count < 4) return null;

  if (count === 4) {
    return ["infected", "doctor", "scanner", "civilian"];
  }

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

function buildFinalRolesText(game) {
  return game.players
    .map((p, i) => `${i + 1}. ${p.name} — ${roleNameRu(p.role)} (${p.alive ? "жив" : "выбыл"})`)
    .join("\n");
}

function checkWinner(game) {
  const infected = getAliveInfected(game).length;
  const nonInfected = getAliveNonInfected(game).length;

  if (infected === 0) return "civilian";
  if (infected >= nonInfected) return "infected";

  return null;
}

function rewardPlayers(game, winner) {
  const rewardLines = [];

  for (const player of game.players) {
    const profile = getProfile(player.id, player.name);
    profile.games += 1;

    let reward = 0;

    if (player.alive) {
      reward += 10;
      profile.survived += 1;
    }

    const isWinner =
      (winner === "infected" && player.role === "infected") ||
      (winner === "civilian" && player.role !== "infected");

    if (isWinner) {
      reward += 10;
      profile.wins += 1;
    }

    profile.coins += reward;
    rewardLines.push(`${player.name} — +${reward} монет`);
  }

  return rewardLines.join("\n");
}

async function finishGame(game, winner) {
  game.phase = "ended";

  const winText =
    winner === "infected"
      ? `🦠 *Победа заражённых!*`
      : `🙂 *Победа мирных!*`;

  const rewardsText = rewardPlayers(game, winner);

  await bot.sendMessage(
    game.chatId,
    `${winText}\n\n*Игроки и роли:*\n${buildFinalRolesText(game)}\n\n*Награды:*\n${rewardsText}`,
    { parse_mode: "Markdown" }
  );

  games.delete(String(game.chatId));
}

function createNightKeyboard(game, actorId, action) {
  const alivePlayers = getAlivePlayers(game).filter((p) => String(p.id) !== String(actorId));

  return {
    inline_keyboard: alivePlayers.map((p) => [
      {
        text: p.name,
        callback_data: `night:${action}:${game.chatId}:${p.id}`
      }
    ])
  };
}

function allNightActionsDone(game) {
  const alivePlayers = getAlivePlayers(game);

  const infectedAlive = alivePlayers.filter((p) => p.role === "infected").length;
  const doctorAlive = alivePlayers.some((p) => p.role === "doctor");
  const scannerAlive = alivePlayers.some((p) => p.role === "scanner");
  const guardAlive = alivePlayers.some((p) => p.role === "guard");

  const infectedDone = Object.keys(game.nightActions.infectedByActor).length >= infectedAlive;
  const doctorDone = !doctorAlive || game.nightActions.doctor !== null;
  const scannerDone = !scannerAlive || game.nightActions.scanner !== null;
  const guardDone = !guardAlive || game.nightActions.guard !== null;

  return infectedDone && doctorDone && scannerDone && guardDone;
}

async function maybeFinishNight(game) {
  if (!allNightActionsDone(game)) return;
  await finishNight(game);
}

async function startNight(game) {
  game.phase = "night";
  game.nightActions = {
    infectedByActor: {},
    doctor: null,
    scanner: null,
    guard: null
  };
  game.votes = {};
  game.voteCountsMessageId = null;
  game.voteMessageId = null;

  await bot.sendMessage(
    game.chatId,
    `🌙 *Ночь ${game.round}*\n\nНочные роли, проверьте личные сообщения.`,
    { parse_mode: "Markdown" }
  );

  for (const player of getAlivePlayers(game)) {
    try {
      if (player.role === "infected") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${game.round}\nВыбери, кого заразить:`,
          { reply_markup: createNightKeyboard(game, player.id, "infect") }
        );
      } else if (player.role === "doctor") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${game.round}\nВыбери, кого лечить:`,
          { reply_markup: createNightKeyboard(game, player.id, "heal") }
        );
      } else if (player.role === "scanner") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${game.round}\nВыбери, кого проверить:`,
          { reply_markup: createNightKeyboard(game, player.id, "scan") }
        );
      } else if (player.role === "guard") {
        await bot.sendMessage(
          player.id,
          `🌙 Ночь ${game.round}\nВыбери, кого защитить:`,
          { reply_markup: createNightKeyboard(game, player.id, "guard") }
        );
      }
    } catch (error) {
      console.log("Ошибка отправки ночного действия:", error.message);
    }
  }

  await maybeFinishNight(game);
}

async function finishNight(game) {
  if (game.phase !== "night") return;

  const infectedChoices = Object.values(game.nightActions.infectedByActor);
  const doctorTarget = game.nightActions.doctor;
  const scannerTarget = game.nightActions.scanner;
  const guardTarget = game.nightActions.guard;

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
    const scanner = getAlivePlayers(game).find((p) => p.role === "scanner");
    const checkedPlayer = getPlayer(game, scannerTarget);

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

  let text = `☀ *День ${game.round}*\n\n`;

  if (!finalTarget) {
    text += `Ночью ничего не произошло.`;
  } else if (finalTarget === doctorTarget || finalTarget === guardTarget) {
    const saved = getPlayer(game, finalTarget);
    if (saved) {
      text += `Ночью попытка заражения была остановлена.\n${saved.name} удалось спасти.`;
    } else {
      text += `Ночью попытка заражения была остановлена.`;
    }
  } else {
    const victim = getPlayer(game, finalTarget);

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

  await bot.sendMessage(game.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(game);
  if (winner) {
    await finishGame(game, winner);
    return;
  }

  await startVoting(game);
}

function buildVotingKeyboard(game) {
  const alivePlayers = getAlivePlayers(game);

  return {
    inline_keyboard: [
      ...alivePlayers.map((p) => [
        {
          text: p.name,
          callback_data: `vote:${game.chatId}:${p.id}`
        }
      ]),
      [
        {
          text: "⏭ Пропуск",
          callback_data: `vote:${game.chatId}:skip`
        }
      ]
    ]
  };
}

function allAliveVoted(game) {
  return getAlivePlayers(game).every((p) => game.votes[String(p.id)] !== undefined);
}

function getVoteCountText(game) {
  const alivePlayers = getAlivePlayers(game);
  const lines = [];

  for (const player of alivePlayers) {
    let count = 0;
    for (const vote of Object.values(game.votes)) {
      if (String(vote) === String(player.id)) {
        count += 1;
      }
    }
    lines.push(`${player.name} — ${count}`);
  }

  let skipCount = 0;
  for (const vote of Object.values(game.votes)) {
    if (vote === "skip") skipCount += 1;
  }
  lines.push(`Пропуск — ${skipCount}`);

  return `📊 *Голоса сейчас:*\n${lines.join("\n")}`;
}

async function updateVoteCountMessage(game) {
  if (!game.voteCountsMessageId) return;

  try {
    await bot.editMessageText(getVoteCountText(game), {
      chat_id: game.chatId,
      message_id: game.voteCountsMessageId,
      parse_mode: "Markdown"
    });
  } catch (error) {
    console.log("Ошибка обновления счетчика голосов:", error.message);
  }
}

async function startVoting(game) {
  game.phase = "voting";
  game.votes = {};

  const voteMsg = await bot.sendMessage(
    game.chatId,
    `📦 *Голосование*\n\nВыберите, кого изгнать.`,
    {
      parse_mode: "Markdown",
      reply_markup: buildVotingKeyboard(game)
    }
  );

  game.voteMessageId = voteMsg.message_id;

  const countsMsg = await bot.sendMessage(
    game.chatId,
    getVoteCountText(game),
    { parse_mode: "Markdown" }
  );

  game.voteCountsMessageId = countsMsg.message_id;
}

async function finishVoting(game) {
  if (game.phase !== "voting") return;

  game.phase = "voting_finished";

  const counts = {};

  for (const target of Object.values(game.votes)) {
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
    const player = getPlayer(game, selected);

    if (player && player.alive) {
      player.alive = false;
      text += `Изгнан игрок: ${player.name}\nРоль игрока: *${roleNameRu(player.role)}*`;
    } else {
      text += `Никто не был изгнан.`;
    }
  }

  await bot.sendMessage(game.chatId, text, { parse_mode: "Markdown" });

  const winner = checkWinner(game);
  if (winner) {
    await finishGame(game, winner);
    return;
  }

  game.round += 1;
  await startNight(game);
}

async function addUserToGame(user, chatId) {
  const game = getGame(chatId);

  if (!game) {
    return { ok: false, text: "Лобби не найдено или игра уже закончилась." };
  }

  if (game.started) {
    return { ok: false, text: "Игра уже началась. Войти нельзя." };
  }

  if (game.players.length >= 8) {
    return { ok: false, text: "Лобби уже заполнено." };
  }

  const already = getPlayer(game, user.id);
  if (already) {
    return { ok: true, text: "Ты уже есть в этом лобби." };
  }

  const name = getDisplayName(user);
  updateProfileName(user.id, name);

  game.players.push({
    id: String(user.id),
    name,
    alive: true,
    role: null
  });

  await renderLobbyMessage(game);

  return { ok: true, text: `✅ Ты добавлен в игру.\nТвой ник: ${name}` };
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  try {
    if (msg.chat.type !== "private") {
      await bot.sendMessage(msg.chat.id, "Напиши мне в личку.");
      return;
    }

    const payload = match && match[1] ? match[1].trim() : "";
    const name = getDisplayName(msg.from);
    updateProfileName(msg.from.id, name);

    if (payload.startsWith("join_")) {
      const chatId = payload.replace("join_", "");
      const result = await addUserToGame(msg.from, chatId);
      await bot.sendMessage(msg.chat.id, result.text);
      return;
    }

    await bot.sendMessage(
      msg.chat.id,
      `Привет, ${name}!\n\nНажми кнопку *Играть* в группе или открой ссылку из лобби.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.log("/start error:", error.message);
  }
});

bot.onText(/^\/create_game$/, async (msg) => {
  try {
    if (msg.chat.type === "private") {
      await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
      return;
    }

    const chatId = String(msg.chat.id);

    if (games.has(chatId)) {
      await bot.sendMessage(msg.chat.id, "В этой группе уже есть активная игра.");
      return;
    }

    const creator = msg.from;
    const creatorName = getDisplayName(creator);
    updateProfileName(creator.id, creatorName);

    const game = {
      chatId,
      creatorId: String(creator.id),
      creatorName,
      players: [
        {
          id: String(creator.id),
          name: creatorName,
          alive: true,
          role: null
        }
      ],
      started: false,
      phase: "lobby",
      round: 1,
      lobbyMessageId: null,
      voteMessageId: null,
      voteCountsMessageId: null,
      nightActions: {
        infectedByActor: {},
        doctor: null,
        scanner: null,
        guard: null
      },
      votes: {}
    };

    games.set(chatId, game);

    const sent = await bot.sendMessage(msg.chat.id, buildLobbyText(game), {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: buildLobbyKeyboard(game)
    });

    game.lobbyMessageId = sent.message_id;
  } catch (error) {
    console.log("/create_game error:", error.message);
    await bot.sendMessage(msg.chat.id, "Ошибка создания игры.");
  }
});

bot.onText(/^\/startgame$/, async (msg) => {
  try {
    if (msg.chat.type === "private") {
      await bot.sendMessage(msg.chat.id, "Эту команду нужно писать в группе.");
      return;
    }

    const game = getGame(msg.chat.id);

    if (!game) {
      await bot.sendMessage(msg.chat.id, "Сначала создай игру через /create_game");
      return;
    }

    if (!isCreator(game, msg.from.id)) {
      await bot.sendMessage(msg.chat.id, "Начать игру может только создатель.");
      return;
    }

    if (game.started) {
      await bot.sendMessage(msg.chat.id, "Игра уже началась.");
      return;
    }

    const roles = getRolesForCount(game.players.length);
    if (!roles) {
      await bot.sendMessage(msg.chat.id, "Для старта нужно минимум 4 игрока.");
      return;
    }

    game.started = true;

    const shuffledPlayers = shuffle(game.players);
    const shuffledRoles = shuffle(roles);

    for (let i = 0; i < shuffledPlayers.length; i++) {
      shuffledPlayers[i].role = shuffledRoles[i] || "civilian";
    }

    await bot.sendMessage(
      msg.chat.id,
      `🎮 *Игра началась!*\n\nИгроков: ${game.players.length}\nРоли отправлены в личные сообщения.`,
      { parse_mode: "Markdown" }
    );

    for (const player of shuffledPlayers) {
      await sendRole(player);
    }

    await startNight(game);
  } catch (error) {
    console.log("/startgame error:", error.message);
    await bot.sendMessage(msg.chat.id, "Ошибка запуска игры.");
  }
});

bot.onText(/^\/cancel_game$/, async (msg) => {
  try {
    const game = getGame(msg.chat.id);

    if (!game) {
      await bot.sendMessage(msg.chat.id, "Активной игры нет.");
      return;
    }

    if (!isCreator(game, msg.from.id)) {
      await bot.sendMessage(msg.chat.id, "Отменить игру может только создатель.");
      return;
    }

    games.delete(String(msg.chat.id));
    await bot.sendMessage(msg.chat.id, "Игра отменена.");
  } catch (error) {
    console.log("/cancel_game error:", error.message);
    await bot.sendMessage(msg.chat.id, "Ошибка отмены игры.");
  }
});

bot.onText(/^\/profile$/, async (msg) => {
  const name = getDisplayName(msg.from);
  const profile = updateProfileName(msg.from.id, name);

  await bot.sendMessage(
    msg.chat.id,
    `👤 *Профиль*\n\n` +
      `Имя: ${profile.name}\n` +
      `Монеты: ${profile.coins}\n` +
      `Игр: ${profile.games}\n` +
      `Побед: ${profile.wins}\n` +
      `Выжил: ${profile.survived}`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/^\/top$/, async (msg) => {
  const top = [...profiles.values()]
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 10);

  if (top.length === 0) {
    await bot.sendMessage(msg.chat.id, "Топ пока пуст.");
    return;
  }

  const text = top
    .map((p, i) => `${i + 1}. ${p.name} — ${p.coins} монет`)
    .join("\n");

  await bot.sendMessage(
    msg.chat.id,
    `🏆 *Топ игроков*\n\n${text}`,
    { parse_mode: "Markdown" }
  );
});

bot.on("callback_query", async (query) => {
  try {
    const data = query.data || "";
    const fromId = String(query.from.id);

    if (data.startsWith("night:")) {
      const [, action, chatId, targetId] = data.split(":");
      const game = getGame(chatId);

      if (!game || game.phase !== "night") {
        await bot.answerCallbackQuery(query.id, { text: "Ночь уже закончилась." });
        return;
      }

      const actor = getPlayer(game, fromId);
      const target = getPlayer(game, targetId);

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

        if (game.nightActions.infectedByActor[fromId]) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        game.nightActions.infectedByActor[fromId] = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты выбрал ${target.name}` });
      }

      if (action === "heal") {
        if (actor.role !== "doctor") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }

        if (game.nightActions.doctor !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        game.nightActions.doctor = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты лечишь ${target.name}` });
      }

      if (action === "scan") {
        if (actor.role !== "scanner") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }

        if (game.nightActions.scanner !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        game.nightActions.scanner = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты проверяешь ${target.name}` });
      }

      if (action === "guard") {
        if (actor.role !== "guard") {
          await bot.answerCallbackQuery(query.id, { text: "Это не твоя роль." });
          return;
        }

        if (game.nightActions.guard !== null) {
          await bot.answerCallbackQuery(query.id, { text: "Ты уже сделал ход." });
          return;
        }

        game.nightActions.guard = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты защищаешь ${target.name}` });
      }

      await maybeFinishNight(game);
      return;
    }

    if (data.startsWith("vote:")) {
      const [, chatId, targetId] = data.split(":");
      const game = getGame(chatId);

      if (!game) {
        await bot.answerCallbackQuery(query.id, { text: "Игра не найдена." });
        return;
      }

      if (game.phase !== "voting") {
        await bot.answerCallbackQuery(query.id, { text: "Голосование уже окончено." });
        return;
      }

      const voter = getPlayer(game, fromId);

      if (!voter || !voter.alive) {
        await bot.answerCallbackQuery(query.id, { text: "Ты не можешь голосовать." });
        return;
      }

      if (game.votes[fromId] !== undefined) {
        await bot.answerCallbackQuery(query.id, { text: "Ты уже проголосовал." });
        return;
      }

      if (targetId === "skip") {
        game.votes[fromId] = "skip";
        await bot.answerCallbackQuery(query.id, { text: "Ты выбрал пропуск." });

        await bot.sendMessage(
          game.chatId,
          `🗳 ${voter.name} проголосовал: *Пропуск*`,
          { parse_mode: "Markdown" }
        );
      } else {
        const target = getPlayer(game, targetId);

        if (!target || !target.alive) {
          await bot.answerCallbackQuery(query.id, { text: "Этот игрок уже недоступен." });
          return;
        }

        game.votes[fromId] = String(targetId);
        await bot.answerCallbackQuery(query.id, { text: `Ты голосуешь против ${target.name}` });

        await bot.sendMessage(
          game.chatId,
          `🗳 ${voter.name} проголосовал против ${target.name}`,
          { parse_mode: "Markdown" }
        );
      }

      await updateVoteCountMessage(game);

      if (allAliveVoted(game)) {
        await finishVoting(game);
      }

      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    console.log("callback_query error:", error);
    try {
      await bot.answerCallbackQuery(query.id, { text: "Ошибка кнопки." });
    } catch (e) {
      console.log("answerCallbackQuery error:", e);
    }
  }
});

bot.on("polling_error", (error) => {
  console.log("Polling error:", error);
});
