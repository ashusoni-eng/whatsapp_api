const express= require("express");
const body_parser= require("body-parser");
const axios= require("axios");
require('dotenv').config();

const app= express().use(body_parser.json());

const api_token=process.env.API_TOKEN;
const mytoken=process.env.MYTOKEN;

app.listen(process.env.PORT,()=>{
    console.log("Wehbhook is listeneing....");
});

app.get("/webhook",(req,res)=>{
    let mode=res.query["hub.mode"];
    let challenge=res.query["hub.challenge"];
    let token=res.query["hub.verify_toke"];


    if(mode && token){

        if(mode==="subscribe" && token===mytoken){
            res.status(200).send(challenge);        
        }else{
            res.status(403);
        }
    }
});

app.post("/webhook",(req,res)=>{
    let body_param= req.body;
    console.log(JSON.stringify(body_param,null,2));

    if(body_param.object){
        if(body_param.entry &&
            body_param.entry[0].changes &&
            body_param.entry[0].changes.value.message &&
            body_param.entry[0].changes.value.message[0]
            ){
                let phone_no_id=body_param.entry[0].changes[0].value.metadata.phone_number_id;
                let from=body_param.entry[0].changes[0].value.message[0].from;
                let msg_body=body_param.entry[0].changes[0].value.message[0].text.body;

                axios({
                    method:"POST",
                    url:"https://graph.facebook.com/v15.0/"+phone_no_id+"/messages?access_token="+api_token,
                    data:{
                        messaging_product:"whatsapp",
                        to:from,
                        text:{
                            body:"Hi.... I am Ashish"
                        }
                    },
                    headers:{
                        "Content-Type":"application/json"
                    }
                });

                res.sendStatus(200);
            }else{
                res.sendStatus(404);
            }
    }
});

app.get("/",(req,res)=>{
    res.status(200).send("This is Webhook Setup");
})
