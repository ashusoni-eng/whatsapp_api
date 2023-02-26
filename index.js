const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const cors = require("cors");

require("dotenv").config();

const app = express().use(body_parser.json());

app.use(cors()); // Enable CORS for all routes

// Store the latest webhook data in memory
let latestData = null;

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Store all webhook data in memory
let allData = {
  messages: [],
};

app.listen(8000 || process.env.PORT, () => {
  console.log("webhook is listening");
});

//to verify the callback url from dashboard side - cloud api side
app.get("/webhook", (req, res) => {
  let mode = req.query["hub.mode"];
  let challange = req.query["hub.challenge"];
  let token = req.query["hub.verify_token"];

  if (mode && token) {
    if (mode === "subscribe" && token === mytoken) {
      res.status(200).send(challange);
    } else {
      res.status(403);
    }
  }
});

app.post("/webhook", (req, res) => {

  let body_param = req.body;

  // Update the latest webhook data
  function updateLatestData(newData) {
    allData.messages.push(newData);
    latestData = newData;
    app.emit("webhook-data-update");
  }


  if (body_param.object) {
    console.log("inside body param");
    if (
      body_param.entry &&
      body_param.entry[0].changes &&
      body_param.entry[0].changes[0].value.messages &&
      body_param.entry[0].changes[0].value.messages[0]
    ) {

      // Store the latest data in memory
      const newData = {
        phone_no_id: body_param.entry[0].changes[0].value.metadata.phone_number_id,
        from: body_param.entry[0].changes[0].value.messages[0].from,
        msg_body: body_param.entry[0].changes[0].value.messages[0].text.body,
        rcv_time: body_param.entry[0].changes[0].value.messages[0].timestamp,
        display_no:body_param.entry[0].changes[0].value.metadata.display_phone_number
      };
      updateLatestData(newData);
      
      axios({
        phone_no_id: body_param.entry[0].changes[0].value.metadata.phone_number_id,
        from: body_param.entry[0].changes[0].value.messages[0].from,
        method: "POST",
        url:"https://graph.facebook.com/v15.0/" +phone_no_id +"/messages?access_token="+token,
        data: {
          messaging_product: "whatsapp",
          to: from,
          text: {
            body: "Welcome! Thank you fomr your message. We will contact you as soon as possible. Or you can call/message us on 07514074672 ",
          },
        },
        headers: {
          "Content-Type": "application/json",
        },
      });

      res.sendStatus(200); 
    }
  }
});

app.delete("/webhook-data", (req, res) => {
  allData.messages = [];
  res.sendStatus(200);
});

// Create a new route for the SSE stream
app.get("/webhook-data", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (allData.messages.length > 0) {
    allData.messages.forEach((data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    });
  }
  const listener = () => {
    res.write(`data: ${JSON.stringify(latestData)}\n\n`);
  };
  app.on("webhook-data-update", listener);

  // Clean up the listener when the client closes the connection
  req.on("close", () => {
    app.off("webhook-data-update", listener);
  });
});
