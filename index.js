var admin = require("firebase-admin");
var express = require("express");
var request = require("request");
var cors = require("cors");
var cookieParser = require('cookie-parser');
var schedule = require('node-schedule');
var jsonfile = require('jsonfile');
const jsdom = require("jsdom");
const { JSDOM } = jsdom;

var app = express();
var port = 3000;
var hostname = '127.0.0.1';

var serviceAccount = require("/opt/firebase/key.json");
var lootAccounts = require("/opt/data/lootAccounts.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://versutianpolls.firebaseio.com"
});

// Map(string:nation, Map(string:key, string:value))
var nationCache = new Map();

// https://stackoverflow.com/a/37510735
function getPropertyValue(object, property) {
  return property
    .split('.') // split string based on
    .reduce(function(o, k) {
      return o && o[k]; // get inner property if `o` is defined else get `o` and return
    }, object); // set initial value as object
}

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

app.use(cors({
  origin: /versutian\.site$/,
  credentials: true
}));
app.use(cookieParser());

var cookieOptions = {
  domain: '.versutian.site',
  maxAge: 3600000,
  httpOnly: true,
  secure: true
};

app.get('/auth/token', function(req, res) {
  var uid = req.query.nation;
  var check = req.query.code;
  if (uid && check) {
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
            console.log("Error creating token: ", error);
            res.send('0');
          });
        });
      }
    });
    return;
  }
  res.send('0');
});

app.get('/auth/state', function(req, res) {
  var token = req.query.token;
  // verify legitimacy of token
  admin.auth().verifyIdToken(token).then(function(decodedToken) {
    res.cookie('token', token, cookieOptions).send('1');
  }).catch(function(error) {
    console.log('Error saving token: ', error);
    res.send('0');
  });
})

app.get('/auth/clear', function(req, res) {
  res.clearCookie('token', cookieOptions);
  res.send('1');
});

// Nations allowed to do administrative actions for wGuild
var wGuildOfficers = ['humantus', 'akohos'];

// Constants
var DAILY_RATE_CAP = 5;
var STARTING_POINTS = 2500;
var POINTS_FLOOR = 1;
var POINTS_CAP = 10000;

var WG_DATA_FILE = "/opt/data/wguild.json";

var wGuildNations = new Map();

jsonfile.readFile(WG_DATA_FILE, function(err, obj) {
  if (err) {
    console.log('Error reading WG data', err);
    process.exit(1);
  } else {
    // Load nation data entries from file
    Object.entries(obj).forEach(function (nation) {
      var name = nation[0];
      var data = nation[1];
      var nationData = new WGuildNationData(name);
      nationData.points = data.points;
      nationData.livePoints = data.livePoints;
      nationData.gain = data.gain;
      nationData.bonus = data.bonus;
      nationData.rate = data.rate;
      nationData.lootboxes = data.lootboxes;
      nationData.freeLootbox = data.freeLootbox;
      nationData.lootBoost = data.lootBoost;
      nationData.highestRank = data.highestRank;
      wGuildNations.set(name, nationData);
    })
  }
});

// Nation data for wGuild
function WGuildNationData(name) {
  this.name = name; // Name of nation
  this.points = STARTING_POINTS; // Monthly rank (excludes gain)
  this.livePoints = STARTING_POINTS; // Live updating rank (includes gain)
  this.gain = 0; // Base points earned monthly
  this.bonus = 0; // Additional bonus points
  this.rate = DAILY_RATE_CAP; // Daily rate
  this.lootboxes = 1; // Number of lootboxes (start with free lootbox)
  this.freeLootbox = true; // Start with complimentary free lootbox
  this.lootBoost = false; // Loot drop boost from special item
  this.highestRank = 2; // Highest rank achieved by this nation
  // The current wGuild rank
  this.getRank = function() {
    return Math.floor(points / 1000);
  };
  // Run every month to award lootboxes and update monthly rank
  this.bumpPoints = function() {
    // Reward 1 lootbox per 250 points earned
    var totalGain = this.gain + this.bonus;
    if (totalGain > 0) {
      this.lootboxes += Math.floor(totalGain / 250);
    }
    // Track change in rank
    var oldRank = getRank();
    // Add net points gain to monthly rank
    this.points += totalGain;
    // Cap points
    if (this.points > POINTS_CAP) {
      this.points = POINTS_CAP;
    } else if (this.points < POINTS_FLOOR) {
      this.points = POINTS_FLOOR;
    }
    // Reset monthly stats
    this.gain = 0;
    this.bonus = 0;
    this.rate = DAILY_RATE_CAP;
    // Get new rank
    var rank = getRank();
    // Rank changed
    if (oldRank !== rank) {
      if (rank > this.highestRank) {
        this.highestRank = rank;
        return 2; // achieved a new higher rank (notify all) 
      } else if (rank === 1) {
        return 2; // got demoted (notify all)
      } else {
        return 1; // changed rank (notify officers)
      }
    }
    return 0; // did not achieve a new rank
  };
  // Award points to the monthly gain for wGuild actions
  this.addPoints = function(add) {
    // Add to gain
    this.gain += add;
    // Calculate bonus points for positive gains
    if (this.gain > 0) {
      this.bonus = Math.round(gain * (((gain / 1000) / Math.sqrt((gain / 1000) + Math.pow(gain / 1000, 2)))));
    } else {
      this.bonus = 0;
    }
    // Update live points
    this.livePoints = this.points + this.gain + this.bonus;
    // Cap points
    if (this.livePoints > POINTS_CAP) {
      this.livePoints = POINTS_CAP;
    } else if (this.livePoints < POINTS_FLOOR) {
      this.livePoints = POINTS_FLOOR;
    }
  };
  // Refresh daily rate from certain wGuild actions
  this.bumpRate = function() {
    // Give daily rate according to current rate
    this.rate = Math.max(1, this.rate) * 2;
    // Cap daily rate
    if (this.rate > DAILY_RATE_CAP) {
      this.rate = DAILY_RATE_CAP;
    }
  };
  // Apply and decay daily rate at the start of each day
  this.updateRate = function() {
    // Apply daily rate
    addPoints(this.rate);
    // Decrease the rate by 1, to a minimum of 0
    if (this.rate > 0) {
      this.rate--;
    }
  };
  // Open a lootbox if there are any
  this.openLootbox = function() {
    if (this.lootboxes > 0) {
      this.lootboxes--;
      if (this.freeLootbox) {
        this.freeLootbox = false;
      } else {
        this.points -= 100;
        this.livePoints -= 100;
      }
      return true;
    }
    return false;
  };
}

app.get('/wg/points/add', function(req, res) {
  var nation = req.query.nation; // Nation getting added
  var token = req.cookies.token; // JWT
  // are they authed and did they specify a valid nation
  if (nation && token && wGuildNations.has(nation)) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to add WGP to nations?
      if (wGuildOfficers.includes(uid)) {
        var member = wGuildNations.get(nation);
        // how many instances of the reward type are we applying?
        var count = req.query.count;
        // if they didn't specify, default to 1
        var adding = true;
        if (!count) {
          count = 1;
          adding = true
        } else {
          adding = count !== 0;
        }
        if (adding) {
          var type = req.query.type; // type of reward
          // specifying the type is required
          if (type) {
            // refresh the daily WGP on applicable types
            if (count > 0 && type === "welcome" || type === "manual") {
              member.bumpRate();
            }
            // determine how much WGP we should add
            var add = 0;
            switch (type) {
              case "standard": // Manual/Standard telegrams
                add = 3 * count;
                break;
              case "mass": // Mass Telegram per 100 stamps
                add = 4 * count;
                break;
              case "api": // Recruitment API per 1 hour
                add = 2 * count;
                break;
              case "welcome": // Manual welcome telegram
                add = 5 * count;
                break;
              case "join": // Referral
                add = 8 * count;
                break;
              case "citizen": // Citizen approval
                add = 12 * count;
                break;
              case "discord": // Discord referral
                add = 14 * count;
                break;
              case "roleplayer": // Roleplay referral
                add = 25 * count;
                break;
              case "vote": // Participation in election vote
                add = 35 * count;
                break;
              case "candidate": // Participation in election race
                add = 50 * count;
                break;
              case "fail": // Improper onboarding process
                add = -30 * count;
                break;
              case "abuse": // Abuse of privileges
                add = -2000 * count;
                break;
              default:
                break;
            }
            // Add the points accordingly
            member.addPoints(add);
            res.send('1');
          }
        }
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.send('0');
    });
    return;
  }
  res.send('0');
});

app.get('/wg/points/get', function(req, res) {
  res.json(write);
});

app.get('/wg/member/add', function(req, res) {
  var nation = req.query.nation; // Nation getting added
  var token = req.cookies.token; // JWT
  // are they authed and did they specify an non-existent nation
  if (nation && token && !wGuildNations.has(nation)) {
    // decode their JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var uid = user.uid; // username
      // are they authorized to add accounts 
      if (wGuildOfficers.includes(uid)) {
        wGuildNations.set(nation, new WGuildNationData(nation));
        res.send('1');
        // Announce a new member!
        nsNation(member, ['name', 'flag'], function(data) {
          // Get friendly name and flag URL
          var nationName = data.get('name');
          var flagImg = data.get('flag');
          // Send to TVF Discord
          request({
              method: 'POST',
              uri: lootAccounts.announce.global,
              json: true, 
              body: {
                content: '**' + nationName + "** just joined the Welcomers' Guild!",
                avatar_url: flagImg
              }
          });
        });
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.send('0');
    });
    return;
  }
  res.send('0');
})

app.get('/wg/loot/roll', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      var member = user.uid;
      // are they a member
      if (wGuildNations.has(member)) {
        var nation = wGuildNations.get(member);
        // if they have a lootbox, open it
        if (nation.openLootbox()) {
          // Roll the numbers
          var tierRoll = Math.random(); // what tier 
          var odds = [0.65, 0.85, 0.95, 0.98]; // default odds
          if (nation.lootBoost) {
            // Odds are boosted, expand non-common tier chance by 5%
            odds.forEach(function(item, index) {
              odds[index] -= (0.05 * (odds.length - index));
            });
            // We've consumed this boost
            nation.lootBoost = false;
          }
          var tier; // loot tier
          var items; // possible items in tier
          if (tierRoll <= odds[0]) {
            tier = 1; // Common
            items = ['115 WGP', 'Gray Background', 'Lime Background', 'Brown Background'];
          } else if (tierRoll <= odds[1]) {
            tier = 2; // Uncommon
            items = ['Baseball Cap', 'Slate Gradient', 'Purple Background', 'Pink Background', 'Cyan Background', '1000 Stamps', '200 WGP'];
          } else if (tierRoll <= odds[2]) {
            tier = 3; // Rare
            items = ['Versutian Gradient Background', 'Top Hat', 'Soot Showers Effect', '500 WGP'];
          } else if (tierRoll <= odds[3]) {
            tier = 4; // Elite
            items = ['Flag Wave', 'Rainbow Gradient Background', 'Ray of Hope Effect', "Man's Not Hot Sound", '630 WGP', '2500 Stamps'];
          } else {
            tier = 5; // Ambassador Select
            items = ['Pulsing Versutian Gradient Background', 'Crown', "Mom's Spaghetti Sound", 'Firey Passion Effect', '5000 Stamps', '1000 WGP'];
          }
          var item = items[Math.floor(Math.random() * items.length)]; // what item in the tier
          nation.lootBoost = Math.random() <= 0.01; // if special
          // Notify admin Discord
          request({method: 'POST', uri: lootAccounts.announce.admin, json: true, body: {content: nation + ' received ' + (special ? 'Special ' : '') + item}}, function(err, response, body) {
            if (!err) {
              // Give client loot info
              res.send({
                tier: tier,
                item: item,
                special: nation.lootBoost
              });
              // Announce special and/or exceedingly rare items
              if (tier > 3 || nation.lootBoost) {
                // Get friendly name and flag image
                nsNation(member, ['name', 'flag'], function(data) {
                  var nationName = data.get('name');
                  var flagImg = data.get('flag');
                  // Send to TVF Discord
                  request({
                      method: 'POST',
                      uri: lootAccounts.announce.global,
                      json: true, 
                      body: {
                        content: '**' + nationName + '** just received an exceedingly rare drop: _' + (special ? 'Special ' : '') + item + '_!!!',
                        avatar_url: flagImg
                      }
                  });
                });
              }
            }
          });
        }
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.send('0');
    });
    return;
  }
  res.send('0');
});

/* TODO
app.get('/wg/loot/equip', function(req, res) {
  var item = req.query.item;
  var nation = req.query.nation;
  if (item && nation) {
      request({method: 'POST', uri: lootkeys.ping, json: true, body: {content: nation + ' equipped ' + item}}, function(err, response, body) {
         if (err) {
           res.send('0');
         } else {
           res.send('1');
         }
      });
  } else {
    res.send('0');
  }
});
*/

app.get('/wg/loot/inventory', function(req, res) {
  var token = req.cookies.token; // JWT
  // are they authed
  if (token) {
    // verify JWT
    admin.auth().verifyIdToken(token).then(function(user) {
      // are they a member?
      if (wGuildNations.has(user.uid)) {
        var nation = wGuildNations.get(user.uid);
        // give inventory info
        res.send({
          count: nation.lootboxes,
          special: nation.lootBoost
        });
      }
    }).catch(function(error) {
      console.log("Error verifying token: ", error);
      res.send('0');
    });
    return;
  }
  res.send('0');
});

app.listen(port, hostname);

var write = {};

// Bump Daily Rate for all members and save
function updateDaily() {
  write = {};
  wGuildNations.forEach(function (member, name) {
    member.bumpRate(); // bump daily rate
    // collect properties
    Object.defineProperty(write, name, {
      configurable: true,
      writable: true,
      enumerable: true,
      value: {
        points: members.points,
        livePoints: member.livePoints,
        gain: member.gain,
        bonus: member.bonus,
        rate: member.rate,
        lootboxes: member.lootboxes,
        freeLootbox: member.freeLootbox,
        lootBoost: member.lootAccounts,
        highestRank: member.highestRank
      }
    });
  });
  // save data
  jsonfile.writeFile(WG_DATA_FILE, write, function(err) {
    console.log('Failed saving data: ', err)
  });
}

// Bump points for all members
function updateMonthly() {
  wGuildNations.forEach(function (member) {
    member.bumpPoints();
  });
}

// Run at midnight, but 1 minute after monthly update
var daily = schedule.scheduleJob('1 0 * * *', function() {
  updateDaily();
});

// Run monthly at midnight
var monthly = schedule.scheduleJob('0 0 1 * *', function() {
  updateMonthly();
});
