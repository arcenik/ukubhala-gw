#! /usr/bin/nodejs
/*******************************************************************************
 *******************************************************************************
 *
 * Requests :
 * ----------
 *
 *  POST /log/pir
 *    post : { 'PIRA1':[...], 'Noise':[...] } 
 *
 *  POST /log/env
 *    post : { "TempInBox": 4, "Humidity": 83, "Luminosity": 204, "CO2": 0} 
 *
 *  GET /photo/check
 *    <- name
 *
 *  POST /photo/send
 *    <- name
 *    <- timestamp
 *    <- md5
 *    post : photo-data (raw)
 *
 *
 *
 * Requirements :
 * --------------
 *
 *  cronolog
 *
 *
 */

var PORT=2180;

if(false)
{ // XXX DEV XXX ==============================================================

    /* path definitions */
    var LOGDIR=__dirname+'/logs'       // relative path
    var PHOTODIR=__dirname+'/photos'       // relative path

    /* MySQL access */
    var mysql      = require('mysql');
    var db_config = {
      host     : '192.168.1.234',
      user     : 'someuser',
      password : 'somepassword'
    };
    var dbname = 'db-dev';

    // detection server
    var DETECT_ENABLED = false;
    var DETECT_HOST = '127.0.0.1';
    var DETECT_PORT = 2100;

    // influxdb
    var INFLUX_ENABLED = true;
    var INFLUXDB_DB = 'db-dev';

} else
{ // XXX PROD XXX =============================================================

    /* path definitions */
    var LOGDIR=__dirname+'/logs'       // relative path
    var PHOTODIR='/var/www/photos/' // absolute path

    /* MySQL access */
    console.log("mysql addr is : ", process.env.DB_PORT_3306_TCP_ADDR); // take parameter from Docker
    var mysql      = require('mysql');
    var db_config = {
      host     : process.env.DB_PORT_3306_TCP_ADDR, 
      user     : 'someuser',
      password : 'somepassword'
    };
    var dbname = 'db-prod';

    // detection server
    var DETECT_ENABLED = false;
    var DETECT_HOST = '127.0.0.1';
    var DETECT_PORT = 2100;

    // influxdb
    var INFLUX_ENABLED = true;
    var INFLUXDB_DB = 'db-prod';

} //  =========================================================================

/* connect to mysql */
var sqlcon;
function handleDisconnect() {
  sqlcon = mysql.createConnection(db_config); // Recreate the connection, since
                                              // the old one cannot be reused.

  sqlcon.connect(function(err) {              // The server is either down
    if(err) {                                 // or restarting (takes a while sometimes).
      console.log('error when connecting to db:', err);
      setTimeout(handleDisconnect, 2000); // We introduce a delay before attempting to reconnect,
    }                                     // to avoid a hot loop, and to allow our node script to
  });                                     // process asynchronous requests in the meantime.
                                          // If you're also serving http, display a 503 error.
  sqlcon.on('error', function(err) {
    console.log('db error', err);
    if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
      handleDisconnect();                         // lost due to either server restart, or a
    } else {                                      // connnection idle timeout (the wait_timeout
      throw err;                                  // server variable configures this)
    }
  });
}
handleDisconnect();

/*
sqlcon.connect(function(err) {
    if (err) {
        logger.error('MySQL connect() : ' + err.stack);
        exit(250);
    }
    logger.info('connected as id ' + sqlcon.threadId);
});
*/

/* open influxdb server */
var INFLUXHOST="http://"+process.env.INFLUXDB_PORT_8086_TCP_ADDR+":"+process.env.INFLUXDB_PORT_8086_TCP_PORT+"/db/"+INFLUXDB_DB+"/series?u=root&p=root";

/* misc binaries */
var cronolog = '/usr/bin/cronolog';

/*******************************************************************************
 *******************************************************************************
 *
 * load modules
 */

var express = require('express');
var bodyParser = require('body-parser')
var fs = require('fs');
var crypto = require('crypto');
var request = require('request');
var subprocess = require('child_process');
var mkdirp = require('mkdirp');
var net = require('net');

/* debug logging */
var log4js = require('log4js');
var logger = log4js.getLogger();

/* access logging */
var log_access  = subprocess.spawn(cronolog, [ LOGDIR+'/%Y-%m/access-%Y-%m-%d.log',  '-S', LOGDIR+'/access.log' ])
var log_error   = subprocess.spawn(cronolog, [ LOGDIR+'/%Y-%m/error-%Y-%m-%d.log',   '-S', LOGDIR+'/error.log' ])
var log_archive = subprocess.spawn(cronolog, [ LOGDIR+'/%Y-%m/archive-%Y-%m-%d.log', '-S', LOGDIR+'/archive.log' ])
function log2error(str)   { log_error.stdin.write(str); }
function log2archive(str) { log_archive.stdin.write(str); }
function log2access(req)  {
    out = "" + Date.now();
    out += "\n";
    console.log(req);
    console.log(out);
    //log_access.stdin.write(out); 
}

/* check directories, add trailing / if missing */
if( PHOTODIR.slice(-1) != "/") { PHOTODIR+="/"; }
if( LOGDIR.slice(-1) != "/") { LOGDIR+="/"; }

/* string format */
var $ = require('stringformat')
$.extendString('format')

// last noise inserted into influxdb
var LastNoise = Date.now();

/*******************************************************************************
 *******************************************************************************
 *
 */
function send2influxdb(data) {
    if( INFLUX_ENABLED ) {
        jsondata = JSON.stringify(data)
        var options = {
            uri: INFLUXHOST,
            method: 'POST',
            body: jsondata
        };
        //console.log("================================================================================");
        //console.log("Send2InfluxDB : ", JSON.stringify(data));

        request(options, function (error, response, body) {
            //console.log("body", body);
            if (!error && response.statusCode != 200) {

                log2error( JSON.stringify({
                    'timestamp':Date.now(),
                    'action':'send2influxdb : influxdb rejected this',
                    'data':data,
                    'response':body
                })+"\n")

                try {
                    logger.error("opentsd was not happy : " + response.statusCode + " / " + body );
                } catch(err) {
                    logger.error("opentsd was not happy : " + response.statusCode );
                }
            }  else  {
                // logger.debug("opentsd response returned 200 ")
            }
        })

    }
}

/*******************************************************************************
 *******************************************************************************
 *
 */

var app = express();

app.get('/', function(req, res){
    logger.debug("Got a GET /");
    res.send("hello world\n");
});

/*******************************************************************************
 *******************************************************************************
 *
 * post_log : receive json objects
 *
 */

var post_log = express();
post_log.use(bodyParser.json());

post_log.on('mount', function(parent) {
    logger.debug("post_log mounted");
});

/*******************************************************************************
 *
 *  /log/pir  <-  { 'PIRA1':[...], 'Noise':[...] }
 *
 */
post_log.post('/pir', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.debug("Got a POST /log/pir")

    /* ---------------------------------------------------------------------- */
    function json_validator(data) {
        if( (! data.hasOwnProperty('PIRA1')) && (! data.hasOwnProperty('PIRA2'))  ) { return false; }
        if( ! data.hasOwnProperty('Noise')) { return false; }
        return true;
    }

    /* ---------------------------------------------------------------------- */
    if( ! json_validator(req.body)) {
        log2archive( JSON.stringify({
            'timestamp':Date.now(),
            'action':'log/pir/ : received data is INVALID',
            'data':req.body,
        })+"\n")
        res.status(400);
        res.send("Invalid json\n");
        return;
    }

    /* -------------------------------------------------------------------------
     * Archive query
     */
    log2archive( JSON.stringify({
        'timestamp':Date.now(),
        'action':'log/pir/ : received data is valid',
        'data':req.body,
    })+"\n")

    /* -------------------------------------------------------------------------
     * put to openinfluxdb
     */
    if( req.body.hasOwnProperty('timestamp')) { tsdts = req.body.timestamp; } else { tsdts = Date.now(); }

    /* -------------------------------------------------------------------------
     * fwbody (forward to java server)
     */
    var fwbody = { 'timestamp':tsdts  };
    var influxout = [];
    var values = [];

    /* -------------------------------------------------------------------------
     * PIRA1
     */
    if(typeof req.body.PIRA1 == "object" ) {
        ts = tsdts - (2000) + (1000/50) // 1.98 sec
        //tsdtags = { "customer":"xtendsys", "city":"Yverdon_les_Bains", "street":"rue_galilee" };
        for(var a in req.body.PIRA1) {
            values.push([(ts),(req.body.PIRA1[a]-128)]);
            ts += (1000/50) // .02 sec
        }
        send2influxdb(influxout);

        // fwbody
        fwbody.PIRA1 = req.body.PIRA1;
    }
    influxout.push({ "name":"ukubhala.yverdon.box001.analog1", "columns":["time","value"], "points":values});

    /* -------------------------------------------------------------------------
     * PIRA2
     */
    if(typeof req.body.PIRA2 == "object" ) {
        ts = tsdts - (2000) + (1000/50) // 1.98 sec
        //tsdtags = { "customer":"xtendsys", "city":"Yverdon_les_Bains", "street":"rue_galilee" };
        for(var a in req.body.PIRA2) {
            values.push([(ts),(req.body.PIRA2[a]-128)]);
            ts += (1000/50) // .02 sec
        }
        send2influxdb(influxout);

        // fwbody
        fwbody.PIRA1 = req.body.PIRA2;
    }
    influxout.push({ "name":"ukubhala.yverdon.box001.analog2", "columns":["time","value"], "points":values});

    /* -------------------------------------------------------------------------
     * Noise
     */
    values = [];
    ts = tsdts - (4500) // 4.5 sec
    // tsdtags = { "customer":"xtendsys", "city":"Yverdon_les_Bains", "street":"rue_galilee" };
    for(var a in req.body.Noise) {
        // console.log( "{0} : {1}".format(ts, req.body.Noise[a]));

        if( ts > LastNoise ) {
            values.push([(ts),(req.body.Noise[a])]);
            ts += (1000/2) // .5 sec
        } else {
            logger.debug("Older noise value ",ts," < ", LastNoise);
        }
    }
    influxout.push({ "name":"ukubhala.yverdon.box001.noise", "columns":["time","value"], "points":values});
    send2influxdb(influxout);

    // fwbody
    fwbody.Noise = req.body.Noise;

    /* -------------------------------------------------------------------------
     * Forward to detection server
     */
    var client = new net.Socket();

    client.connect(DETECT_PORT, DETECT_HOST, function() {
        var out = JSON.stringify(fwbody) + "\n";
        // logger.debug("[detection_fw] sending : " + out);
        client.write(out);
    });

    client.on('error', function (e) {
        logger.error("[log/pir] pb forwarding to detection server " + e);
    });

    client.on('data', function(data) {
        // logger.debug("[detection_fw] received : " + data);
        completed = true;
        client.end(); // close the connection
    });

    client.on('close', function() {
        // logger.debug("[detection_fw] connection closed");
        client.destroy();
    });

    /* -------------------------------------------------------------------------
     * final result
     */
    out = "OK";
    res.send(out);
});

/*******************************************************************************
 *
 *  /log/env  <-  { "TempInBox": 4, "Humidity": 83, "Luminosity": 204, "CO2": 0}
 *
 */
post_log.post('/env', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.debug("Got a POST /log/env");

    /* ---------------------------------------------------------------------- */
    function json_validator(data) {
        var res = false;
        if( data.hasOwnProperty('TempInBox')) { res=true; }
        if( data.hasOwnProperty('Humidity')) { res=true; }
        if( data.hasOwnProperty('Luminosity')) { res=true; }
        if( data.hasOwnProperty('CO2real')) { res=true; }
        return res;
    }

    /* ---------------------------------------------------------------------- */
    if( ! json_validator(req.body)) {
        log2archive( JSON.stringify({
            'timestamp':Date.now(),
            'action':'log/env/ : received data is INVALID',
            'data':req.body,
        })+"\n")
        res.status(400);
        res.send("Invalid json\n");
        return;
    }

    /* -------------------------------------------------------------------------
     * Archive query
     */
    log2archive( JSON.stringify({
        'timestamp':Date.now(),
        'action':'log/env/ : received data is valid',
        'data':req.body,
    })+"\n")

    /* -------------------------------------------------------------------------
     * put to openinfluxdb
     */
    if( req.body.hasOwnProperty('timestamp')) { tsdts = req.body.timestamp; } else { tsdts = Date.now(); }
    influxout = []

    if( req.body.hasOwnProperty('TempInBox') ) {
        values=[(tsdts),(req.body.TempInBox) ];
        influxout.push({ "name":"ukubhala.yverdon.box001.tempinbox", "columns":["time","value"], "points":[values]});
    }
    if( req.body.hasOwnProperty('Humidity') ) {
        values=[tsdts,req.body.Humidity ];
        influxout.push({ "name":"ukubhala.yverdon.box001.humidity", "columns":["time","value"], "points":[values]});
    }
    if( req.body.hasOwnProperty('Luminosity') ) {
        values=[tsdts,req.body.Luminosity ];
        influxout.push({ "name":"ukubhala.yverdon.box001.luminosity", "columns":["time","value"], "points":[values]});
    }

    if( req.body.hasOwnProperty('CO2real') ) {
        if(req.body.CO2real > 100) {
            values=[tsdts,req.body.CO2real ];
            influxout.push({ "name":"ukubhala.yverdon.box001.co2", "columns":["time","value"], "points":[values]});
        } else {
            logger.debug("ignoring invalid co2 value : "+ req.body.CO2real);
        }
    }

    // console.log("sending to influxdb : "+ influxout);
    // logger.debug("sending to influxdb : "+ influxout);
    send2influxdb(influxout);

    /* -------------------------------------------------------------------------
     * final result
     */
    out = "OK";
    res.send(out);
});

/*******************************************************************************
*
*  /log/button  <-  {"Button": "truck", "timestamp": "2015-06-15 10:05:50", "ts-s": 13377, "ts-ms": 598}
*
*    Button_value :
*
*       "people" -> 1
*       "bike"   -> 2
*       "car"    -> 3
*       "truck"  -> 4
*    
*/
post_log.post('/button', function(req, res){

   /* ---------------------------------------------------------------------- */
   logger.debug("Got a POST /log/button");

   /* ---------------------------------------------------------------------- */
   function json_validator(data) {
       res = false;
       if( data.hasOwnProperty('Button')) { res=true; }
       if( data.hasOwnProperty('ts-s')) { res=true; }
       if( data.hasOwnProperty('ts-ms')) { res=true; }
       if( data.hasOwnProperty('timestamp')) { res=true; }
       return res;
   }

   /* ---------------------------------------------------------------------- */
   if( ! json_validator(req.body)) {
       log2archive( JSON.stringify({
           'timestamp':Date.now(),
           'action':'log/button/ : received data is INVALID',
           'data':req.body,
       })+"\n")
       res.status(400);
       res.send("Invalid json\n");
       return;
   }

   var typeint=-1;
   if( req.body.Button == "people")     { typeint = 1; }
   else if( req.body.Button == "bike")  { typeint = 2; }
   else if( req.body.Button == "car")   { typeint = 3; }
   else if( req.body.Button == "truck") { typeint = 4; }
   else {
       
       log2archive( JSON.stringify({
           'timestamp':Date.now(),
           'action':'log/button/ : INVALID button value',
           'data':req.body,
       })+"\n")
       res.status(400);
       res.send("Invalid json, button value\n");
       return;
       
   }
   
   /* -------------------------------------------------------------------------
    * Archive query
    */
   log2archive( JSON.stringify({
       'timestamp':Date.now(),
       'action':'log/button/ : received data is valid',
       'data':req.body,
   })+"\n")

    var query = "INSERT INTO {0}.report(type,timestamp,tss, tsms ) VALUES(\"{1}\",\"{2}\",\"{3}\") ".format(
            dbname,
            typeint,
            req.body.timestamp,
            req.body.tss,
            req.body.tsms
        )
        // logger.debug(query);

        sqlcon.query(query, function(err, rows, fields) {
            if (err) {
                logger.error(err);
                out= JSON.stringify({"result":false, "mysql_error":err });
                failed = true;
            }

            sqlcon.commit(function(err) {
                if (err) { 
                  sqlcon.rollback(function() { throw err; });
                }   
            }); // sql commit

        }); // sql insert
   
});

/*******************************************************************************
 *
 *  /log/*
 *
 */
post_log.post('/', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.warning("Got a unhandled POST / ")
    log2error("post_log : Got a unhandled POST / ")

    /* ---------------------------------------------------------------------- */
    out = "Unhandled request\n";
    res.status(404);
    res.send(out);

});

post_log.get('/', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.warning("Got a unhandled GET / ")
    log2error("post_log : Got a unhandled GET / ")

    /* ---------------------------------------------------------------------- */
    out = "Unhandled request\n";
    res.status(404);
    res.send(out);

});

/*******************************************************************************
 *******************************************************************************
 *
 * post_photo : receive json objects
 *
 * POST /photo/
 *
 */

var post_photo = express();

post_photo.use(function(req, res, next) {
    var data = new Buffer('');
    req.on('data', function(chunk) {
        data = Buffer.concat([data, chunk]);
    });
    req.on('end', function() {
        req.rawBody = data;
        next();
    });
});

post_photo.on('mount', function(parent) {
    logger.debug("post_photo mounted");
});

/*******************************************************************************
 *
 *  /photo/check check for photo absence before sending
 *
 *  GET /photo/check
 *    <- name
 *
 */
post_photo.get('/check', function(req, res){

    /* ---------------------------------------------------------------------- */
    res.setHeader('Content-Type', 'application/json')
    logger.info("Got a GET /photo/check")
    //logger.debug(req.query)

    /*--------------------------------------------------------------------------
     * parameters
     */

    // TODO : Check query parameters !! XXX

    var name=req.query.name;

    /*--------------------------------------------------------------------------
     * query
     */
    var query = "SELECT count(idphoto) AS c FROM {0}.photos WHERE photo_filename = \"{1}\"".format(dbname,name)
    // logger.debug(query);

    var failed = false;
    var out=undefined;

    sqlcon.query(query, function(err, rows, fields) {
        if (err) {
            logger.error(err);
            out= JSON.stringify({"result":false, "mysql_error":err });
            failed = true;
        } else {
            if( rows[0].c == "0") {
                out = JSON.stringify({"result":true});
            } else {
                out = JSON.stringify({"result":false});
            }
        }

        // logger.debug("photo/check returning : ", out);
        res.send(out);

    });

});

/*******************************************************************************
 *
 *  /photo/send
 *
 *  POST /photo/send
 *    <- name
 *    <- timestamp
 *    <- md5
 *    post : photo-data (raw)
 *
 */
post_photo.post('/send', function(req, res){

    /* -------------------------------------------------------------------------- */
    function checksum (str, algorithm, encoding) {
        return crypto
            .createHash(algorithm || 'md5')
            .update(str, 'utf8')
            .digest(encoding || 'hex')
    }

    // TODO : Check query parameters !! XXX

    /* ---------------------------------------------------------------------- */
    res.setHeader('Content-Type', 'text/plain')
    logger.info("Got a POST /photo/send")
    // logger.debug(req.query)

    /* ---------------------------------------------------------------------- */
    var data = req.rawBody;
    var datamd5 = checksum(data)

    if( datamd5 != req.query.md5 ) {
        res.status(400);
        res.send("Invalid request : md5sum do not match data !!");
        return;
    }

    /* ---------------------------------------------------------------------- */
    // logger.debug("query timestamp", parseInt(req.query.timestamp));
    var pdate = new Date(parseInt(req.query.timestamp));
    // logger.debug("received ts : ", pdate);

    pyear = pdate.getFullYear();
    pmonth = ("00" + (pdate.getMonth()+1)).slice(-2);
    pday   = ("00" + (pdate.getDate())).slice(-2);
    pmilisec = String(parseFloat(req.query.timestamp%1000)/1000).slice(1);

    var outdir = pyear + "-" + pmonth + "/"+pday + "/";

    // create dir, set output
    try {
        mkdirp(PHOTODIR+outdir, function(e) { 

            filename = outdir+req.query.name;
            fs.writeFile(PHOTODIR + filename, data, function(err) {
                if(err) {
                    logger.error("[/photo/send/] File write : ]" + err);
                } else {
                    logger.debug("[/photo/send/] File was saved as : "+ filename);
                    var failed = false;
                    // logger.debug("TS : ", req.query.timestamp, (req.query.timestamp%1000));

                    var query = "INSERT INTO {0}.photos(photo_timestamp, photo_filename, photo_full_path ) VALUES(\"{1}\",\"{2}\",\"{3}\") ".format(
                        dbname,
                        pdate.toISOString().slice(0, 19).replace('T', ' ')+pmilisec,
                        req.query.name,
                        filename
                    )
                    // logger.debug(query);

                    sqlcon.query(query, function(err, rows, fields) {
                        if (err) {
                            logger.error(err);
                            out= JSON.stringify({"result":false, "mysql_error":err });
                            failed = true;
                        }

                        sqlcon.commit(function(err) {
                            if (err) { 
                              sqlcon.rollback(function() { throw err; });
                            }   
                        }); // sql commit

                    }); // sql insert

                }
            });

            out = "Thanks for you POST\n"; // TODO set a better output XXX
            res.send(out);

        });

    } catch(e) {
        logger.error("mkdirp : " + e);
        out="mkdirp : "+e;
        res.status(503);
        res.send(out);

    }
});

/*******************************************************************************
 *
 *  /log/*
 *
 */
post_photo.post('/', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.warning("Got a unhandled POST / ")
    log2error("post_photo : Got a unhandled POST / ")

    /* ---------------------------------------------------------------------- */
    out = "Unhandled request\n";
    res.status(404);
    res.send(out);

});

post_photo.get('/', function(req, res){

    /* ---------------------------------------------------------------------- */
    logger.warning("Got a unhandled GET / ")
    log2error("post_photo : Got a unhandled GET / ")

    /* ---------------------------------------------------------------------- */
    out = "Unhandled request\n";
    res.status(404);
    res.send(out);

});

/*******************************************************************************
 *******************************************************************************
 *
 *
 */

app.use('/log',post_log);
app.use('/photo',post_photo);
logger.info("Ready to serve !");
app.listen(PORT);


