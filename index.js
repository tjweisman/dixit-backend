const PORT = process.env.PORT || 3000;
const app = require('express')();
const http = require('http').createServer(app);
var io = require('socket.io')(http);

const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

client.connect();

app.get('/', (req, res) => {
  res.send('');
});

http.listen(PORT, () => {
	console.log("listening...");
});

function handle_generic_error(err, data, callback) {
  console.log(err.stack);
  data.response = "error";
  data.error = "unknown";
  callback(data);
}


async function join_game(socket, username, game, callback) {
  var uid;
  var response_data = {
    username:username,
    game:game
  };
  let join_status = await user_can_join(username, game);
  if(!join_status.allowed) {
    response_data.response = "error";
    response_data.error = join_status.reason;
    callback(response_data);
    return;
  }
  client.query("INSERT INTO users(name, game) VALUES($1, $2) RETURNING uid",
      [username, game])
    .then(async res => {
      uid = res.rows[0].uid;
      return await client.query("INSERT INTO games(name, turn) VALUES($1, $2) \
      ON CONFLICT ON CONSTRAINT name_unique DO UPDATE SET name = EXCLUDED.name RETURNING gid, state;",
      [game, uid]).catch(err => {handle_generic_error(err, response_data, callback);});
    })
    .then(res => {
      client.query("UPDATE users SET gid = $1, socket = $3 WHERE uid = $2;",
        [res.rows[0].gid, uid, socket.id]).catch(err => {handle_generic_error(err, response_data, callback);});

      socket.join(res.rows[0].gid);

      response_data.response = "success";
      response_data.uid = uid;
      response_data.gid = res.rows[0].gid;
      response_data.game_data = {
        state:res.rows[0].state
      }

      callback(response_data);
      socket.to(res.rows[0].gid).emit("player join");


      console.log("new user " + username + " joined game "+ game);
    }).catch(err => {
      if(err.code == 23505 && err.constraint == "user_game") {

        console.log("user " + username + " rejoined game " + game);
        rejoin_user(socket, username, game, callback);

        //response_data.response = "error";
        //response_data.error = "user_in_game";
      } else {
        handle_generic_error(err, response_data, callback);
      }
    });
}

async function rejoin_user(socket, username, game, callback) {
  let response_data = {
    response:"success",
    username:username,
    game:game
  };

  const res = await client.query("UPDATE users SET socket = $1 WHERE name = $2 RETURNING uid;", 
    [socket.id, username]);
  uid = res.rows[0].uid;

  game_data = await get_game_data(game);
  response_data.uid = uid;
  response_data.gid = game_data.gid;
  response_data.game_data = game_data;

  socket.join(game_data.gid);
  callback(response_data);
}

async function user_can_join(user, game) {
  let game_data = await get_game_data(game);
  let join_status = {
    allowed:true
  };

  //no game initialized: fine to join
  if(!game_data) {
    return join_status;
  }
  let res = await client.query("SELECT * FROM users WHERE gid = $1 AND name = $2;",
    [game_data.gid, user]);

  //the game has started and the user doesn't already exist: can't join
  if(!(game_data.state == "pregame") && res.rows.length == 0) {
    join_status.allowed = false;
    join_status.reason = "in_progress"
    return join_status;
  } else if(res.rows.length == 0) {
    return join_status;
  }
  console.log("socket: ");
  console.log(res.rows[0].socket);
  if(res.rows[0].socket) {
    console.log("socket was not null.");
    join_status.allowed = false;
    join_status.reason = "user_connected";
    return join_status;
  }
  return join_status;
}

function update_game_state(gid, state) {
  client.query("UPDATE games SET state = $1 WHERE gid = $2;",
    [state, gid]);
}

function update_score(uid, score) {
  client.query("UPDATE users SET score = $1 WHERE uid = $2;",
    [score, uid]);
}

function delete_all_data() {
  client.query("DELETE FROM games;");
}

async function get_room_id(room) {
  try {
    const res = await client.query("SELECT gid FROM games WHERE name = $1", [room]);
    return res.rows[0].gid;
  } catch(err) {
    console.log(err.stack);
  }
}

async function get_room_name(gid) {
  try {
    const res = await client.query("SELECT name FROM games WHERE gid = $1", [gid]);
    return res.rows[0].name;
  } catch(err) {
    console.log(err.stack);
  }
}

async function get_username(uid) {
  const res = await client.query("SELECT name FROM users WHERE uid = $1;", [uid]);
  return res.rows[0].name;
}

async function get_uid(username) {
  const res = await client.query("SELECT uid FROM users WHERE name = $1;", [username]);
  return res.rows[0].uid;
}

async function get_remaining_cards(gid) {
  const res = await client.query("SELECT * FROM cards WHERE gid = $1 AND state = 'deck';",
    [gid]);
  console.log("remaining cards: " + res.rows.length);
  return res.rows.length;
}

async function get_game_data(name) {
  const res = await client.query("SELECT * FROM games WHERE name = $1;", [name]);
  return res.rows[0];
}

async function setup_cards(gid) {
  await client.query("INSERT INTO cards(filename, gid) (SELECT filename, gid FROM default_cards INNER JOIN games ON $1 = gid);",
    [gid]);
}

function begin_game(gid) {
  client.query("UPDATE games SET state = 'prompt' WHERE gid = $1;",
    [gid]);
  begin_turn(gid, 0);
  io.to(gid).emit('start game');
}

async function deal_cards(gid, to_deal) {

  let res = await client.query("SELECT cid, filename FROM cards WHERE gid = $1 AND state='deck' ORDER BY random();", [gid]);
  cards = res.rows;

  name = await get_room_name(gid);

  res = await client.query("SELECT uid FROM users WHERE game = $1;", [name]);
  let num_users = res.rows.length;
  let counter = 0;
  let total_cards = Math.min(num_users * to_deal, cards.length);
  console.log("total cards = " + total_cards)

  var hand_updates = new Array(total_cards);
  while(counter < total_cards && counter < cards.length) {
    hand_updates[counter] = client.query("UPDATE cards SET uid = $1, state = 'hand' WHERE cid = $2", 
      [res.rows[counter % num_users].uid, cards[counter].cid]);
    counter++;
  }
  let remaining_cards = cards.length - counter;
  await Promise.all(hand_updates);
  broadcast_cards(gid, remaining_cards);
}

function broadcast_cards(gid, remaining_cards) {
  client.query("SELECT cid, filename, uid, state FROM cards WHERE gid = $1 AND state = 'hand' OR state = 'table';", [gid])
  .then(res => {
    console.log("sending deal message");
    console.log(res.rows);
    io.to(gid).emit('card update', {
      cards: res.rows,
      remaining: remaining_cards
    });
  });
}

function play_card(cid) {
  client.query("UPDATE cards SET state = 'table' WHERE cid = $1;", [cid]);
}

function reset_player_actions(gid) {
  client.query("UPDATE users SET player_action = 0 WHERE gid = $1;", [gid]);
}

function set_guesser_actions(gid, turn, guesser_action) {
  client.query("UPDATE users SET player_action = $3 WHERE gid = $1 AND uid != $2",
    [gid, turn, guesser_action]);
}

async function reset_game(gid) {
  client.query("UPDATE users SET score = 0 WHERE gid = $1;", [gid]);
  client.query("UPDATE games SET state = 'pregame', turn_index = 0 WHERE gid = $1;", [gid]);
}

async function initialize_game(gid, options) {
  await client.query("DELETE FROM cards WHERE gid = $1", [gid]);
  await setup_cards(gid);

  client.query("UPDATE games SET hand_size = $1 WHERE gid = $2;",
    [options.hand_size, gid]);
  
  deal_cards(gid, options.hand_size);
  begin_game(gid);
}

function receive_prompt(data) {
  client.query("UPDATE users SET player_action = $1 WHERE gid = $2 AND uid = $3;",
    [data.cid, data.gid, data.uid]).catch(e => {
      console.log(e.stack);
    });
  client.query("UPDATE games SET prompt = $1 WHERE gid = $2;",
    [data.prompt, data.gid]);
  play_card(data.cid);
}

function shuffle(array) {
  let n = array.length;
  let shuffled = new Array(n);
  let indices = [...Array(n).keys()];

  for(let i = 0;i < n; i++) {
    index = indices.splice(Math.floor(Math.random() * (n - i)), 1)[0];
    shuffled[index] = array[i];
  }
  return shuffled;
}

async function receive_action(data) {
  await client.query("UPDATE users SET player_action = $1 WHERE gid = $2 AND uid = $3;",
    [data.cid, data.gid, data.uid]);

  res = await client.query("SELECT uid FROM users WHERE gid = $1 AND player_action = 0;",
    [data.gid]);

  if(res.rows.length > 0) {
    return false;
  }
  return true;
}

async function advance_turn(gid) {
  const res = await client.query("UPDATE games SET turn_index = turn_index + 1 WHERE gid = $1 RETURNING turn_index;", [gid]);
  begin_turn(gid, res.rows[0].turn_index);
}

async function begin_turn(gid, turn_index) {
  const res = await client.query("SELECT uid FROM users WHERE gid = $1 ORDER BY turn_order;", 
    [gid]);

  let num_users = res.rows.length;
  let next_player = res.rows[turn_index % num_users].uid;

  client.query("UPDATE games SET turn = $1 WHERE gid = $2;", [next_player, gid]);
  client.query("UPDATE cards SET state = 'discard' WHERE gid = $1 AND state = 'table';", [gid]);
  reset_player_actions(gid);

  update_game_state(gid, 'prompt');
  io.to(gid).emit('round prompt', {
      uid:next_player
    });
}

async function get_users(gid, callback) {
  try {
      if(gid != 0) {
        var res = await client.query("SELECT * FROM users WHERE gid = $1;", [gid]);
      } else {
        var res = await client.query("SELECT * FROM users;");
      }
      callback(res.rows);
  } catch(err) {
    console.log(err.stack);
  }
}

io.set('transports', ['websocket']);

io.on('connection', (socket) => {
	console.log("New connection.");
	socket.on("join game", (data, callback) => {
		
    console.log("User wants to join game.");
		console.log(data);

    join_game(socket, data["username"], data["game"], callback);
	});

  socket.on("delete all", () => {
    delete_all_data();
  });

  socket.on("get users", (game, callback) => {
    get_users(game, callback);
  });

  socket.on("start game", (data) => {
    initialize_game(data.gid, data.options);
  });

  socket.on("prompt", (data, callback) => {
    console.log("got prompt");
    console.log(data);

    receive_prompt(data);
    update_game_state(data.gid, 'secret');
    io.to(data.gid).emit("other prompt", data);
    callback();
  });

  socket.on("choose secret", async data => {
    play_card(data.cid);
    io.to(data.gid).emit("other secret", data);
    let players_ready = await receive_action(data);
    if(players_ready) {
      update_game_state(data.gid, 'guess');
      set_guesser_actions(data.gid, data.turn, 0);
      io.to(data.gid).emit("round guess", {
        order:shuffle([...Array(data.num_players).keys()])
      });
    }
  });

  socket.on("guess card", async data => {
    io.to(data.gid).emit("other guess", data);
    let players_ready = await receive_action(data);
    if(players_ready) {
      io.to(data.gid).emit("reveal guess", {});
      deal_cards(data.gid, 1);
      advance_turn(data.gid);
    }
  });

  socket.on("score update", data => {
    update_score(data.uid, data.score);
  });

  socket.on("get cards", async data => {
    num_remaining = await get_remaining_cards(data.gid);
    broadcast_cards(data.gid, num_remaining);
  });

  socket.on("disconnect", (reason) => {
    console.log("client disconnected. reason: "+ reason);
    client.query("UPDATE users SET socket = NULL WHERE socket = $1;", [socket.id]);
  });

  socket.on("reset game", data => {
    console.log("Received reset request");
    reset_game(data.gid);
    io.to(data.gid).emit("reset game");
  });

});