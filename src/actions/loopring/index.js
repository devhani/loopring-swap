import React from "react";
import Wallet from "../../lightcone/wallet";
import {
    lightconeGetAccount,
    getExchangeInfo,
} from "../../lightcone/api/LightconeAPI";
import { toast } from "react-toastify";
import { getTokenInfo } from "../../lightcone/api/v1/tokeninfo/get";
import { FormattedMessage } from "react-intl";
import { getBalances } from "../../lightcone/api/v1/balances/get";
import { getLoopringApiKey } from "../../utils/loopring";
import BigNumber from "bignumber.js";
import { getDepth } from "../../lightcone/api/v1/depth/get";
import { getMarketInfo } from "../../lightcone/api/v1/marketinfo/get";

// login

export const LOGIN_SUCCESS = "LOGIN_SUCCESS";

export const login = (web3Instance, selectedWeb3Account) => async (
    dispatch
) => {
    try {
        const wallet = new Wallet(
            "MetaMask",
            web3Instance,
            selectedWeb3Account
        );
        // custom notification in case the account is not registered
        let account;
        try {
            account = await lightconeGetAccount(selectedWeb3Account);
        } catch (error) {
            toast.warn(<FormattedMessage id="warn.account.not.found" />);
            console.warn("account not found");
            return;
        }
        const exchange = await getExchangeInfo();
        const { exchangeAddress } = exchange;
        const { keyPair } = await wallet.generateKeyPair(
            exchangeAddress,
            account.keyNonce
        );
        if (!keyPair) {
            // the user most probably aborted the signing
            console.warn("The user aborted the signing process");
            return;
        }
        const { publicKeyX, publicKeyY } = keyPair;
        if (
            account.publicKeyX !== publicKeyX ||
            account.publicKeyY !== publicKeyY
        ) {
            throw new Error(
                "api got and locally generated public keys don't match"
            );
        }
        wallet.keyPair = keyPair;
        wallet.accountId = account.accountId;
        dispatch({ type: LOGIN_SUCCESS, account, wallet, exchange });
    } catch (error) {
        toast.error(<FormattedMessage id="error.login" />);
        console.error("error initializing loopring", error);
    }
};

// get supported tokens

export const GET_SUPPORTED_TOKENS_START = "GET_SUPPORTED_TOKENS_START";
export const GET_SUPPORTED_TOKENS_END = "GET_SUPPORTED_TOKENS_END";
export const GET_SUPPORTED_TOKENS_SUCCESS = "GET_SUPPORTED_TOKENS_SUCCESS";

export const getSupportedTokens = (supportedMarkets) => async (dispatch) => {
    dispatch({ type: GET_SUPPORTED_TOKENS_START });
    try {
        const supportedTokens = await getTokenInfo();
        const filteredSupportedTokens = supportedTokens.reduce(
            (accumulator, token) => {
                const { tokenId } = token;
                const fromToken = supportedMarkets.find(
                    (market) => market.quoteTokenId === tokenId
                );
                if (fromToken) {
                    accumulator.fromTokens.push(token);
                }
                const toToken = supportedMarkets.find(
                    (market) => market.baseTokenId === tokenId
                );
                if (toToken) {
                    accumulator.toTokens.push(token);
                }
                if (fromToken || toToken) {
                    accumulator.aggregated.push(token);
                }
                return accumulator;
            },
            { fromTokens: [], toTokens: [], aggregated: [] }
        );
        dispatch({
            type: GET_SUPPORTED_TOKENS_SUCCESS,
            supportedTokens: filteredSupportedTokens,
        });
    } catch (error) {
        toast.error(<FormattedMessage id="error.supported.tokens" />);
        console.error("error getting supported tokens", error);
    }
    dispatch({ type: GET_SUPPORTED_TOKENS_END });
};

// get supported markets

export const GET_SUPPORTED_MARKETS_START = "GET_SUPPORTED_MARKETS_START";
export const GET_SUPPORTED_MARKETS_END = "GET_SUPPORTED_MARKETS_END";
export const GET_SUPPORTED_MARKETS_SUCCESS = "GET_SUPPORTED_MARKETS_SUCCESS";

export const getSupportedMarkets = () => async (dispatch) => {
    dispatch({ type: GET_SUPPORTED_MARKETS_START });
    try {
        dispatch({
            type: GET_SUPPORTED_MARKETS_SUCCESS,
            supportedMarkets: await getMarketInfo(),
        });
    } catch (error) {
        toast.error(<FormattedMessage id="error.supported.markets" />);
        console.error("error getting supported markets", error);
    }
    dispatch({ type: GET_SUPPORTED_MARKETS_END });
};

// get user balances

export const GET_USER_BALANCES_START = "GET_USER_BALANCES_START";
export const GET_USER_BALANCES_END = "GET_USER_BALANCES_END";
export const GET_USER_BALANCES_SUCCESS = "GET_USER_BALANCES_SUCCESS";

export const getUserBalances = (account, wallet, supportedTokens) => async (
    dispatch
) => {
    dispatch({ type: GET_USER_BALANCES_START });
    try {
        const partialBalances = await getBalances(
            account.accountId,
            await getLoopringApiKey(wallet, account),
            supportedTokens
        );
        // we process the tokens with no balance too,
        // saving them with a 0 balance if necessary
        const allBalances = supportedTokens
            .filter((supportedToken) => supportedToken.enabled)
            .reduce((allBalances, supportedToken) => {
                const supportedTokenId = supportedToken.tokenId;
                const supportedTokenSymbol = supportedToken.symbol;
                const matchingBalance = partialBalances.find(
                    (balance) => balance.tokenId === supportedTokenId
                );
                const balance = new BigNumber(
                    matchingBalance ? matchingBalance.totalAmount : "0"
                );
                allBalances.push({
                    id: supportedTokenId,
                    symbol: supportedTokenSymbol,
                    name: supportedToken.name,
                    address: supportedToken.address,
                    balance,
                });
                return allBalances;
            }, [])
            .sort((a, b) => b.balance.minus(a.balance).toNumber());
        dispatch({ type: GET_USER_BALANCES_SUCCESS, balances: allBalances });
    } catch (error) {
        toast.error(<FormattedMessage id="error.user.balances" />);
        console.error("error getting user balances", error);
    }
    dispatch({ type: GET_USER_BALANCES_END });
};

// get current exchange rate

export const GET_SWAP_DATA_START = "GET_SWAP_DATA_START";
export const GET_SWAP_DATA_END = "GET_SWAP_DATA_END";
export const GET_SWAP_DATA_SUCCESS = "GET_SWAP_DATA_SUCCESS";

export const getSwapData = (
    fromToken,
    toToken,
    fromAmount,
    supportedTokens
) => async (dispatch) => {
    dispatch({ type: GET_SWAP_DATA_START });
    try {
        const market = `${toToken.symbol}-${fromToken.symbol}`;
        const { asks } = await getDepth(market, 0, 200, supportedTokens);
        const bestPrice = asks[0].price;
        const estimatedToAmount = new BigNumber(fromAmount).dividedBy(
            bestPrice
        );

        // fetching all the orders required to fill the requested size
        const requiredOrders = [];
        let totalOrdersSize = new BigNumber("0");
        for (let i = 0; i < asks.length; i++) {
            const ask = asks[i];
            requiredOrders.push(ask);
            totalOrdersSize = totalOrdersSize.plus(ask.size);
            if (totalOrdersSize.isGreaterThanOrEqualTo(estimatedToAmount)) {
                break;
            }
        }
        if (totalOrdersSize.isLessThan(estimatedToAmount)) {
            toast.error(<FormattedMessage id="error.swap.size" />);
            console.error("the swap size is too much");
            return;
        }
        const averageFillPrice = requiredOrders
            .reduce(
                (pricesSum, { price }) => pricesSum.plus(price),
                new BigNumber("0")
            )
            .dividedBy(requiredOrders.length);

        dispatch({
            type: GET_SWAP_DATA_SUCCESS,
            averageFillPrice: averageFillPrice,
            slippagePercentage: new BigNumber(averageFillPrice)
                .minus(bestPrice)
                .dividedBy(averageFillPrice)
                .multipliedBy("100"),
            maximumAmount: asks.reduce(
                (totalSize, ask) => totalSize.plus(ask.size),
                new BigNumber("0")
            ),
        });
    } catch (error) {
        toast.error(<FormattedMessage id="error.swap.data" />);
        console.error("error getting swap data", error);
    } finally {
        dispatch({ type: GET_SWAP_DATA_END });
    }
};