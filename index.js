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

async function join_room(socket, username, room, callback) {
  try {
    let res = await client.query("INSERT INTO users(name, game) VALUES($1, $2) RETURNING uid;",
      [username, room]);

    uid = res.rows[0].uid;

    res = await client.query("INSERT INTO games(name, turn) VALUES($1, $2) \
      ON CONFLICT ON CONSTRAINT name_unique DO NOTHING;",
      [room, uid]);

    console.log("user " + username + " joined room "+ room);
  } catch (err) {
    if(err.code == 23505 && err.constraint == "user_room") {
      callback({
        response:"error",
        error:"user_in_room",
        username:username,
        room:room
      });
    } else {
      console.log(err.stack);
      callback({
        response:"error",
        error:"unknown",
        username:username,
        room:room
      });
    }
  }
  callback({
    response:"success",
    username:username,
    room:room
  });
  socket.join(room);
}

function delete_all_data() {
  client.query("DELETE FROM cards;")
  .then(res => client.query("DELETE FROM games;"))
  .then(res => client.query("DELETE FROM users;"));
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

function setup_cards(gid) {
  client.query("INSERT INTO cards(filename, gid) (SELECT filename, gid FROM default_cards INNER JOIN games ON $1 = gid);",
    [gid]);
}

function begin_game(gid) {
  client.query("UPDATE games SET in_progress = TRUE WHERE gid = $1;",
    [gid]);
  console.log("wow, no errors.");
}

function deal_cards(gid) {
  const res = await client.query("SELECT cid, filename FROM cards WHERE gid = $1;", [gid]);
  name = await get_room_name(gid);

  
}

async function initialize_room(room) {
  gid = await get_room_id(room);
  client.query("DELETE FROM cards WHERE gid = $1", [gid])
  .then(res => setup_cards(gid))
  .then(res => begin_game(gid));
}

async function get_users(room, callback) {
  try {
      if(room != "") {
        var res = await client.query("SELECT * FROM users WHERE room = $1;");
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
		
    console.log("User wants to join room.");
		console.log(data);

    join_room(socket, data["username"], data["game"], callback);
	});

  socket.on("delete all", () => {
    delete_all_data();
  });

  socket.on("get users", (room, callback) => {
    get_users(room, callback);
  });

  socket.on("start game", (room) => {
    initialize_room(room);
  });

});