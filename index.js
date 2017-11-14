var admin = require("firebase-admin");
var express = require("express");
var request = require("request");
var cors = require("cors");
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

var app = express();
var port = 3000;
var hostname = '127.0.0.1';

var serviceAccount = require("/opt/firebase/key.json");

// Map(string:nation, Map(string:key, string:value))
var nationCache = new Map();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://versutianpolls.firebaseio.com"
});

app.use(cors());
app.listen(port, hostname);

/*
function requestApiSafe(url, callback, xml) {
        request(url, function(reqe, reqr, reqb) 
            // check if we are on NS API cooldown
            if (url.startsWith('https://www.nationstates.net/cgi-bin/api.cgi?nation=')) {
                // notify the user that they're on API cooldown
                if (xhr.status === 429) {
                    // notify the user once
                    return;
                } else {
                    // reset ban notification tracker
                    nsBan = false;
                }
            }
            // give our callback XML if it requested it
            callback();
        };
        xhr.open("GET", url);
        xhr.send();
}
*/

function nsNation(nation, data, callback) {
        // check if we have a cache entry for this nation at all
        if (!nationCache.has(nation)) {
            nationCache.set(nation, new Map());
        }
        // get the cache map for this nation
        var nationData = nationCache.get(nation);
        // check data that has been cached and skip getting it from the API
        var requestString = "";
        var requests = [];
        for (var i = 0; i < data.length; i++) {
            if (!nationData.has(data[i]) || nationData.get(data[i]).length === 0) {
                requests.push(data[i]);
                if (requestString.length === 0) {
                    requestString = data[i];
                } else {
                    requestString += "+" + data[i];
                }
            }
        }
        // check if we have data to get from the API
        if (requestString.length !== 0) {
            // request the data
            var options = {
              url: "https://www.nationstates.net/cgi-bin/api.cgi?nation=" + nation + "&q=" + requestString,
              headers: {
                "User-Agent": "Versutian Web Service by Humantus"
              }
            };
            request(options, function(nationErr, nationH, nationRes) {
                dom = new JSDOM(nationRes);
                for (var i = 0; i < requests.length; i++) {
                    // check if we got data from the API
                    if (nationRes === null) {
                        // blank data since callbacks expect non-null
                        nationData.set(request[i], "");
                    } else {
                        // cache data we got from the API
                        nationData.set(requests[i], dom.window.document.querySelector(requests[i].toUpperCase()).textContent);
                    }
                }
                // give freshly cached data to the callback
                callback(nationData);
            });
        } else {
            // give cached data to the callback
            callback(nationData);
        }
}

app.get('/token', function(req, res) {
  var check = req.query.token;
  var uid = req.query.nation;
  if (check && uid) {
    var options = {
       url: 'https://www.nationstates.net/cgi-bin/api.cgi?a=verify&nation=' + uid + '&checksum=' + check,
       headers: {
         'User-Agent': 'Versutian Web Service by Humantus'
       }
    }
    request(options, function(reqe, reqr, reqb) {
      if (reqb && reqb.includes('1')) {
        nsNation(uid, ['flag', 'name'], function(data) {
         var claims = {
            nation: data.get('name'),
            flag: data.get('flag')
          };
          admin.auth().createCustomToken(uid, claims).then(function(token) {
            res.send(token);
          }).catch(function(error) {
            console.log("Error creating token:", error);
          });
        });        
      } else {
        res.send('0');
      }
    });
  } else {
    res.send('0');
  }
});
