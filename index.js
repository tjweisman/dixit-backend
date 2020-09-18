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

client.query('SELECT table_schema,table_name FROM information_schema.tables;', (err, res) => {
  if (err) throw err;
  for (let row of res.rows) {
    console.log(JSON.stringify(row));
  }
  client.end();
});


app.get('/', (req, res) => {
  res.send('');
});

http.listen(PORT, () => {
	console.log("listening...");
});

io.set('transports', ['websocket']);

io.on('connection', (socket) => {
	console.log("New connection.");
	socket.on("state update", (state) => {
		console.log("Received status update:");
		console.log(state);
		socket.broadcast.emit("state update", state);
	});
});