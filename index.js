var admin = require("firebase-admin");
var express = require("express");
var cors = require("cors");
var app = express();
var port = 3000;
var hostname = '127.0.0.1';

var serviceAccount = require("/opt/firebase/key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://versutianpolls.firebaseio.com"
});

app.use(cors());
app.listen(port, hostname);

app.get('/token', function(req, res) {
  var uid = req.query.nation;
  admin.auth().createCustomToken(uid)
    .then(function(token) {
      res.send(token);
    })
    .catch(function(error) {
      console.log("Error creating token:", error);
    });
});
