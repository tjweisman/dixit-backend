const PORT = process.env.PORT || 3000;
const app = require('express')();
const http = require('http').createServer(app);
var io = require('socket.io')(http);


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