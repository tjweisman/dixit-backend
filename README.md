# Dixit backend

This is the backend for a node.js implementation of the card game Dixit.

## Playing the game

The client-side of the game is (currently) accessible at [https://web.ma.utexas.edu/users/weisman/dixit/dixit.html](https://web.ma.utexas.edu/users/weisman/dixit/dixit.html). All of the cards are custom-drawn.

## Warnings

- This code is pretty brittle, since I'm a crummy JavaScript programmer and an even crummier node.js programmer. Catching SQL errors is for losers (a.k.a. good programmers)
- The server is hosted on Heroku with a free plan, so I have a limited amount of uptime per month
- There's no server-side validation of incoming messages from the client, so it's totally possible to write an alternative client to really gum up the database or crash the server
- It's quite easy to reset the database remotely, so nefarious users can easily kill your game using built-in functionality
- The client (hosted at the link above) logs basically everything, so if you keep an eye on the logs it's very easy to cheat at the game
- the rules of Dixit are probably copyrighted so this could get me into some trouble