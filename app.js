const Exchange = artifacts.require('Exchange');
const ZeroEx = require('0x.js');
const rp = require('request-promise');
const appConfig = require('./config.js');
const tokenContractABI = require('./tokenABI.js');
const BigNumber = require('@0xproject/utils').BigNumber;


module.exports = function (callback) {
  web3.eth.getAccounts((error, addresses) => {
    let configs = {
      networkId: 1,
    };
    let zeroEx = new ZeroEx.ZeroEx(web3.currentProvider, configs);
    let followingAddress = appConfig.followingAddress;
    if (followingAddress === '' || followingAddress === undefined || followingAddress === addresses[0]) {// Invalid address
      return;
    }
    let exchange = Exchange.at(zeroEx.exchange.getContractAddress());
    // Get transaction event of all trade transaction on contract.
    // Filter only following address to copy the transaction.
    let fillEvent = exchange.LogFill();
    fillEvent.watch(function (err, orderLog) {
      if (err) {
        console.log(err);
        return;
      }
      console.dir(orderLog);
      let isMaker = false;
      let contractAddress = '';
      let tokenTradeAmount = 0;
      if (orderLog.args.maker === followingAddress) {
        isMaker = true;
        contractAddress = orderLog.args.makerToken;
        tokenTradeAmount = orderLog.args.filledMakerTokenAmount;
      } else if (orderLog.args.taker === followingAddress) {
        isMaker = false;
        contractAddress = orderLog.args.takerToken;
        tokenTradeAmount = orderLog.args.filledTakerTokenAmount;
      } else { // Not following address.
        return;
      }

      let tokenContract = web3.eth.contract(tokenContractABI).at(contractAddress);
      tokenContract.balanceOf(followingAddress, function (error, followingBalance) {
        tokenContract.balanceOf(addresses[0], function (error, followerBalance) {
          let tokenBalanceBeforeTrade = followingBalance.add(tokenTradeAmount);
          let tradePart = tokenTradeAmount.div(tokenBalanceBeforeTrade); // Calculate part of traded.
          let rate = orderLog.args.filledMakerTokenAmount.div(orderLog.args.filledTakerTokenAmount);
          let followerMakerAmount = 0;
          let followerTakerAmount = 0;
          let makerOrderToken = orderLog.args.makerToken;
          let takerOrderToken = orderLog.args.takerToken;
          if (isMaker) {
            followerMakerAmount = followerBalance.mul(tradePart).mul(appConfig.portionOfFund);
            followerTakerAmount = followerMakerAmount.dividedToIntegerBy(rate);
          } else {
            followerTakerAmount = followerBalance.mul(tradePart).mul(appConfig.portionOfFund);
            followerMakerAmount = followerTakerAmount.mul(rate);
            makerOrderToken = orderLog.args.takerToken;
            takerOrderToken = orderLog.args.makerToken;
          }

          if (followerMakerAmount === 0 || followerMakerAmount === 0) { // Check value
            return;
          }

          // Order will be valid 1 hour.
          let duration = 3600;
          let order = {
            // The default web3 account address
            maker: addresses[0],
            // Anyone may fill the order
            taker: '0x0000000000000000000000000000000000000000',
            makerTokenAddress: makerOrderToken,
            takerTokenAddress: takerOrderToken,
            makerTokenAmount: followerMakerAmount,
            takerTokenAmount: followerTakerAmount,
            // Add the duration (above) to the current time to get the unix
            // timestamp
            expirationUnixTimestampSec: parseInt(
              (new Date().getTime() / 1000) + duration
            ).toString(),
            // We need a random salt to distinguish different orders made by
            // the same user for the same quantities of the same tokens.
            salt: ZeroEx.ZeroEx.generatePseudoRandomSalt()
          };

          order.exchangeContractAddress = zeroEx.exchange.getContractAddress();
          let relayBaseURL = appConfig.relayBaseURL;
          rp({
            method: 'POST',
            uri: relayBaseURL + '/v0/fees',
            body: order,
            json: true,
          }).then((feeResponse) => {
            // Convert the makerFee and takerFee into BigNumbers
            order.makerFee = new BigNumber(feeResponse.makerFee);
            order.takerFee = new BigNumber(feeResponse.takerFee);
            // The fee API tells us what feeRecipient to specify
            order.feeRecipient = feeResponse.feeRecipient;
            // Once those promises have resolved, our order is ready to be signed
            let orderHash = ZeroEx.ZeroEx.getOrderHashHex(order);
            return zeroEx.signOrderHashAsync(orderHash, order.maker, false);
          }).then((signature) => {
            order.ecSignature = signature;
            console.dir(order);
            return zeroEx.token.setProxyAllowanceAsync(
              order.makerTokenAddress,
              order.maker,
              new BigNumber(order.makerTokenAmount)
            )
          }).then((tokenAllowance) => {
            return zeroEx.token.setProxyAllowanceAsync(
              '0xe41d2489571d322189246dafa5ebde1f4699f498',
              order.maker,
              order.makerFee
            )
          }).then((feeAllowance) => {
            return rp({
              method: 'POST',
              uri: relayBaseURL + '/v0/order',
              body: order,
              json: true,
            })
          }).then((orderPromise) => {

          }).catch((something) => {
            console.dir(something);
          })
        });
      })
    });
  });
};