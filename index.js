const express=require("express");
const body_parser=require("body-parser");
const axios=require("axios");
const cors = require("cors");


require('dotenv').config();

const app=express().use(body_parser.json());

app.use(cors());    // Enable CORS for all routes

// Store the latest webhook data in memory
let latestData = null;


const token=process.env.TOKEN;
const mytoken=process.env.MYTOKEN;//prasath_token
let webData={};



app.listen(8000||process.env.PORT,()=>{
    console.log("webhook is listening");
});

//to verify the callback url from dashboard side - cloud api side
app.get("/webhook",(req,res)=>{
   let mode=req.query["hub.mode"];
   let challange=req.query["hub.challenge"];
   let token=req.query["hub.verify_token"];


    if(mode && token){

        if(mode==="subscribe" && token===mytoken){
            res.status(200).send(challange);
        }else{
            res.status(403);
        }

    }

});

app.post("/webhook",(req,res)=>{ //i want some 

    let body_param=req.body;

    // console.log(JSON.stringify(body_param,null,2));
    webData= body_param;


            /*use to send auto reply when someone send message*/
//     if(body_param.object){
//         console.log("inside body param");
//         if(body_param.entry && 
//             body_param.entry[0].changes && 
//             body_param.entry[0].changes[0].value.messages && 
//             body_param.entry[0].changes[0].value.messages[0]  
//             ){
//                let phon_no_id=body_param.entry[0].changes[0].value.metadata.phone_number_id;
//                let from = body_param.entry[0].changes[0].value.messages[0].from; 
//                let msg_body = body_param.entry[0].changes[0].value.messages[0].text.body;

//                console.log("phone number "+phon_no_id);
//                console.log("from "+from);
//                console.log("boady param "+msg_body);

//                axios({
//                    method:"POST",
//                    url:"https://graph.facebook.com/v13.0/"+phon_no_id+"/messages?access_token="+token,
//                    data:{
//                        messaging_product:"whatsapp",
//                        to:from,
//                        text:{
// //                            body:"Hi.. I'm Ashish, your message is "+msg_body
//                                 body:"Hi.. I'm Ashish, We will contact you as soon as possible. Or you can call us on 07512437375 "
//                        }
//                    },
//                    headers:{
//                        "Content-Type":"application/json"
//                    }

//                });

//                res.sendStatus(200);
//             }else{
//                 res.sendStatus(404);
//             }

//     }
        
    // Store the latest data in memory
    // latestData = {
    //     phone_no_id: phon_no_id,
    //     from: from,
    //     msg_body: msg_body,
    //   };

    
      // Emit an event to indicate that the latestData variable has been updated
    app.emit("webhook-data-update");
    
    
    res.sendStatus(200);            //if remove comment than it should also removed
});


// app.get("/",(req,res)=>{
//     res.status(200).send(webData);
// });


// Create a new route for the SSE stream
app.get("/webhook-data",(req,res)=>{
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    if (latestData) {
        res.write(`data: ${JSON.stringify(latestData)}\n\n`);
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

    // res.status(200).send(webData);