const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post('/webhook', (req, res) => {
  const { messages } = req.body;

  if (messages) {
    messages.forEach(message => {
      console.log(`Received message from ${message.sender}: ${message.body}`);
      // add your code to handle the received message here
    });
  }

  res.status(200).send();
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});
