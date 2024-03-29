require('dotenv').config()
const { parseUnits } = require('@ethersproject/units')
const ethers = require('ethers')
const configs = require('./configs')
const { logType } = require('./enums')
const { log, confirmYesNo, sleep } = require('./utils')
const contractAbi = require('./contract-abi')
const { getTokenInformation, getHoneypotChecker } = require('./repo')

const provider = new ethers.providers.WebSocketProvider(configs.WSSProvider)
const wallet = new ethers.Wallet(configs.userWalletPrivateKey, provider)

let targetTokenDecimal
let WBNBDecimal

let isTheTargetTokenAlreadyBought = false
let userBalanceOfTargetTokenAfterBought
let userAmountOfWBNBAfterBought // this will used to calculate price changed

// TODO
// useing big integer to some calculation
// sell process
// - calculate sell with tax
// alert
// - when the price is lower send to telegram
// refactor

const _contractFactory = (dataContracts) => {
	const results = []
	for (const dataContract of dataContracts) {
		results.push(new ethers.Contract(dataContract.address, dataContract.contractAbi, provider))
	}
	return results
}

const [
	contractPancakeswapV2Router,
	contractPancakeswapV2Factory,
	contractTargetToken,
	contractWBNBToken,
] = _contractFactory([
	{
		address: configs.pancakeSwapV2RouterAddress,
		contractAbi: contractAbi.pancakeswapV2Router,
	},
	{
		address: configs.pancakeSwapV2FactoryAddress,
		contractAbi: contractAbi.pancakeswapV2Factory,
	},
	{
		address: configs.targetTokenAddress,
		contractAbi: contractAbi.BEP20,
	},
	{
		address: configs.WBNBContractAddress,
		contractAbi: contractAbi.BEP20,
	},
])

const _getTimeDeadline = async () => {
	return Date.now() + configs.transactionDeadlineInSecond
}

const _buyToken = async (minAmountOutIn) => {
	const tx = await contractPancakeswapV2Router
		.connect(wallet)
		.swapExactTokensForTokens(
			configs.amountOfWBNB,
			minAmountOutIn,
			[configs.WBNBContractAddress, configs.targetTokenAddress],
			configs.userWalletAddress,
			_getTimeDeadline(),
			{
				gasLimit: configs.buyTokenGasLimit,
				gasPrice: configs.gasPrice,
				nonce: null,
			}
		)
	await tx.wait()
	return tx
}

const _selltoken = async (amountoftargettoken, minamountoutin) => {
	const tx = await contractpancakeswapv2router
		.connect(wallet)
		.swapexacttokensfortokens(
			amountoftargettoken,
			minamountoutin,
			[configs.targettokenaddress, configs.wbnbcontractaddress],
			configs.userwalletaddress,
			_gettimedeadline(),
			{
				gaslimit: configs.selltokengaslimit,
				gasprice: configs.gasprice,
				nonce: null,
			}
		)
	await tx.wait()
	return tx
}

const _getBalanceOfPool = async (pair) => {
	const [balanceOfWBNB, balanceOfTargetToken] = await Promise.all([
		contractWBNBToken.balanceOf(pair),
		contractTargetToken.balanceOf(pair),
	])
	return {
		balanceOfWBNB: balanceOfWBNB,
		balanceOfTargetToken: balanceOfTargetToken,
	}
}

const _getPairFromEvent = (event) => {
	const iface = new ethers.utils.Interface(contractAbi.pancakeswapV2Factory)
	const result = iface.parseLog(event)
	return result.args.pair
}

const _getAmountOutTargetToken = async () => {
	const amountsOutResult = await contractPancakeswapV2Router.getAmountsOut(configs.amountOfWBNB, [
		configs.WBNBContractAddress,
		configs.targetTokenAddress,
	])
	let amountOfTargetToken = amountsOutResult[1]
	return amountOfTargetToken
}

const _getAmountOutWBNB = async () => {
	const amountsOutResult = await contractPancakeswapV2Router.getAmountsOut(
		userBalanceOfTargetTokenAfterBought,
		[configs.targetTokenAddress, configs.WBNBContractAddress]
	)
	let amountOfTargetToken = amountsOutResult[1]
	return amountOfTargetToken
}

const _getPriceImpactInPercentage = (balanceOfPool, amountOfTargetToken) => {
	const marketPriceTargetTokenPerWBNB = balanceOfPool.balanceOfTargetToken.div(
		balanceOfPool.balanceOfWBNB
	)

	const amountOfMarketPriceTargetToken = configs.amountOfWBNB.mul(marketPriceTargetTokenPerWBNB)
	const priceImpact =
		100 -
		(parseFloat(amountOfTargetToken.toString()) / parseFloat(amountOfMarketPriceTargetToken)) * 100

	return priceImpact
}

const _getMinAmountOut = (amount) => {
	return amount.sub(amount.div('100').mul(configs.slipppagePercentage))
}

const _isWBNBApproved = async () => {
	const [allowance, balanceWBNBOfUser] = await Promise.all([
		contractWBNBToken.allowance(configs.userWalletAddress, configs.pancakeSwapV2RouterAddress),
		contractWBNBToken.balanceOf(configs.userWalletAddress),
	])

	if (allowance.lt(balanceWBNBOfUser)) {
		return false
	}

	return true
}
const _isTargetTokenApproved = async () => {
	const [allowance, balanceTargetTokenOfUser] = await Promise.all([
		contractTargetToken.allowance(configs.userWalletAddress, configs.targetTokenAddress),
		contractTargetToken.balanceOf(configs.userWalletAddress),
	])

	if (allowance.lt(balanceTargetTokenOfUser)) {
		return false
	}

	return true
}

const _approveWBNB = async () => {
	const tx = await contractWBNBToken.connect(wallet).approve(
		configs.pancakeSwapV2RouterAddress,
		'115792089237316195423570985008687907853269984665640564039457584007913129639935' // max approve
	)
	await tx.wait()
	return tx
}
const _approveTargetToken = async () => {
	const tx = await contractTargetToken.connect(wallet).approve(
		configs.pancakeSwapV2RouterAddress,
		'115792089237316195423570985008687907853269984665640564039457584007913129639935' // max approve
	)
	await tx.wait()
	return tx
}

const _getTokenInformation = async () => {
	let tokenInformation
	try {
		tokenInformation = await getTokenInformation(configs.targetTokenAddress)
		if (tokenInformation.ABI === 'Contract source code not verified') {
			return false
		}
	} catch (_) {
		// TODO catch error
		return false
	}
	return tokenInformation
}

const _getHoneypotChecker = async () => {
	let honeypotChecker
	try {
		honeypotChecker = await getHoneypotChecker(configs.targetTokenAddress)
	} catch (e) {
		// TODO catch error
		return false
	}
	return honeypotChecker
}

const _getPriceDifferenceInPercentage = async () => {
	const percetage =
		100 -
		(100 / parseFloat(configs.amountOfWBNB.toString())) *
			parseFloat(userAmountOfWBNBAfterBought.toString())
	return percetage
}

const _detectPriceTargetToken = async () => {
	while (true) {
		await sleep(1000)
		if (!isTheTargetTokenAlreadyBought) {
			continue
		}

		// set initial target token price
		if (!userBalanceOfTargetTokenAfterBought && !userAmountOfWBNBAfterBought) {
			const balanceOfTargetToken = await contractTargetToken.balanceOf(configs.userWalletAddress)
			userBalanceOfTargetTokenAfterBought = balanceOfTargetToken
			userAmountOfWBNBAfterBought = await _getAmountOutWBNB()
		}

		const priceDifferencePercentage = await _getPriceDifferenceInPercentage()
		const mintAmountOut = _getMinAmountOut(userAmountOfWBNBAfterBought)

		log(`Price differece percentage: ${priceDifferencePercentage}%`, logType.ok)

		// take profit or cut loss
		if (
			priceDifferencePercentage >= configs.sellTargetInPercentage ||
			priceDifferencePercentage <= configs.sellCutLossInPercentage
		) {
			let txSell
			try {
				txSell = await _sellToken(userBalanceOfTargetTokenAfterBought, mintAmountOut)
			} catch (error) {
				console.log(error)
				// TODO proper handle error transaction
				const txError = JSON.parse(JSON.stringify(error))
				log(`Error TX sell token: ${txError.transactionHash} | ${txError.reason}`, logType.danger)
				log('exiting..\n', logType.ok)
				return
			}
			log(`TX sell success: ${txSell.hash}\n`, logType.ok)
			log(
				`Amount of WBNB: ${configs.amountOfWBNB} (Unit) | ${ethers.utils.formatUnits(
					configs.amountOfWBNB,
					WBNBDecimal
				)} (decimal)`,
				logType.ok
			)

			log(
				`Estimate min amount of WBNB after sell (not included tax): ${mintAmountOut} (Unit) | ${ethers.utils.formatUnits(
					mintAmountOut,
					WBNBDecimal
				)} (decimal)`,
				logType.ok
			)
			return
		}
	}
}

const autoSell = async () => {
	_detectPriceTargetToken()
}

const _buyOnLiquidityAdded = async (event) => {
	const pair = _getPairFromEvent(event)

	log('Liquidity is detected\n', logType.ok)
	log('Getting balance of liquidity..\n', logType.ok)
	const [balanceOfPool, amountOfTargetToken] = await Promise.all([
		_getBalanceOfPool(pair),
		_getAmountOutTargetToken(),
	])
	log(
		`Balance of pool target token: ${
			balanceOfPool.balanceOfTargetToken
		} (Unit) | ${ethers.utils.formatUnits(
			balanceOfPool.balanceOfTargetToken,
			targetTokenDecimal
		)} (Decimal)`,
		logType.ok
	)
	log(
		`Balance of pool WBNB: ${balanceOfPool.balanceOfWBNB} (Unit) | ${ethers.utils.formatUnits(
			balanceOfPool.balanceOfWBNB,
			WBNBDecimal
		)} (Decimal)`,
		logType.ok
	)

	if (balanceOfPool.balanceOfTargetToken.eq(ethers.utils.parseUnits('0'))) {
		log(`Validation error: balance of pool target token is zero`, logType.danger)
		log('exiting..\n', logType.ok)
		return
	}

	// skip when the balance of pool is less than minimum liquidity added
	if (balanceOfPool.balanceOfWBNB.lt(configs.minLiquidityWBNBAdded)) {
		log(
			`Validation error: balance of WBNB is less than min liquidity WBNB added (${balanceOfPool.balanceOfWBNB} < ${configs.minLiquidityWBNBAdded})`,
			logType.danger
		)
		log('exiting..\n', logType.ok)
		return
	}

	// skip when the price impact is higher than the limit
	const priceImpactInPercentage = _getPriceImpactInPercentage(balanceOfPool, amountOfTargetToken)
	log(`Price impact: ${priceImpactInPercentage}%\n`, logType.ok)
	if (priceImpactInPercentage > configs.priceImpactToleranceInPercentage) {
		log(
			`Validation error: price impact is higher than the limit (${priceImpactInPercentage}% > ${configs.priceImpactToleranceInPercentage}%)`,
			logType.danger
		)
		log('exiting..\n', logType.ok)
		return
	}

	// sleep before buy
	log(`Sleep for ${configs.sleepBeforeBuyInMiliSecond}ms ..`, logType.ok)
	await sleep(configs.sleepBeforeBuyInMiliSecond)

	// buy the token
	const mintAmountOut = _getMinAmountOut(amountOfTargetToken)
	log('Process buy token..\n', logType.ok)
	log(
		`Amount in: ${configs.amountOfWBNB} (Unit) | ${ethers.utils.formatUnits(
			configs.amountOfWBNB,
			WBNBDecimal
		)} (Decimal)`,
		logType.ok
	)
	log(
		`Min amount out: ${mintAmountOut} (Unit) | ${ethers.utils.formatUnits(
			mintAmountOut,
			targetTokenDecimal
		)} (Decimal)\n`,
		logType.ok
	)

	let txBuy
	try {
		txBuy = await _buyToken(mintAmountOut)
	} catch (error) {
		// TODO proper handle error transaction
		const txError = JSON.parse(JSON.stringify(error))
		log(`Error TX buy token: ${txError.transactionHash} | ${txError.reason}`, logType.danger)
		log('exiting..\n', logType.ok)
		return
	}
	log(`TX buy success: ${txBuy.hash}\n`, logType.ok)
	isTheTargetTokenAlreadyBought = true
}

const detectLiquidity = async () => {
	const filter = contractPancakeswapV2Factory.filters.PairCreated(
		[configs.WBNBContractAddress, configs.targetTokenAddress],
		[configs.WBNBContractAddress, configs.targetTokenAddress]
	)
	provider.on(filter, _buyOnLiquidityAdded)
}

const startUp = async () => {
	log('Getting config & token information..\n', logType.ok)
	let [
		_WBNBDecimal,
		_targetTokenDecimal,
		targetTokenName,
		targetTokenSymbol,
		targetTokenTotalSupply,
		balanceWBNBOfUser,
		isWBNBApproved,
		isTargetTokenApproved,
		tokenInformation,
		honeypotChecker,
	] = await Promise.all([
		contractWBNBToken.decimals(),
		contractTargetToken.decimals(),
		contractTargetToken.name(),
		contractTargetToken.symbol(),
		contractTargetToken.totalSupply(),
		contractWBNBToken.balanceOf(configs.userWalletAddress),
		_isWBNBApproved(),
		_isTargetTokenApproved(),
		_getTokenInformation(),
		_getHoneypotChecker(),
	])
	targetTokenDecimal = _targetTokenDecimal
	WBNBDecimal = _WBNBDecimal

	log(`User wallet address: ${configs.userWalletAddress}`, logType.ok)
	log(
		`User WBNB balance: ${balanceWBNBOfUser} (Unit) | ${ethers.utils.formatUnits(
			balanceWBNBOfUser,
			WBNBDecimal
		)} (decimal)\n`,
		logType.ok
	)
	log(
		`Amount of WBNB: ${configs.amountOfWBNB} (Unit) | ${ethers.utils.formatUnits(
			configs.amountOfWBNB,
			WBNBDecimal
		)} (decimal)`,
		logType.ok
	)
	log(`WBNB contract address: ${configs.WBNBContractAddress}`, logType.ok)
	log(
		`Min liqudity added: ${configs.minLiquidityWBNBAdded} (Unit) | ${ethers.utils.formatUnits(
			configs.minLiquidityWBNBAdded,
			WBNBDecimal
		)} (decimal)`,
		logType.ok
	)
	log(`Price impact tolerance: ${configs.priceImpactToleranceInPercentage}%`, logType.ok)
	log(`Transaction deadline: ${configs.transactionDeadlineInSecond}s`, logType.ok)
	log(
		`Gas price: ${configs.gasPrice} (Unit) | ${ethers.utils.formatUnits(
			configs.gasPrice,
			'gwei'
		)} (GWEI)`,
		logType.ok
	)
	log(`Buy token gas limit: ${configs.buyTokenGasLimit}`, logType.ok)
	log(`Sell token gas limit: ${configs.sellTokenGasLimit}`, logType.ok)
	log(`Pancakeswap V2 factory address: ${configs.pancakeSwapV2FactoryAddress}`, logType.ok)
	log(`Pancakeswap V2 router address: ${configs.pancakeSwapV2RouterAddress}`, logType.ok)
	log(`WSS provider: ${configs.WSSProvider}\n`, logType.ok)

	log(`Target token address: ${configs.targetTokenAddress}`, logType.ok)
	log(`Target token name: ${targetTokenName}`, logType.ok)
	log(`Target token symbol: ${targetTokenSymbol}`, logType.ok)
	log(`Target token decimal: ${targetTokenDecimal}`, logType.ok)
	log(
		`Target token total supply: ${targetTokenTotalSupply} (unit) | ${ethers.utils.formatUnits(
			targetTokenTotalSupply,
			targetTokenDecimal
		)} (decimal)\n`,
		logType.ok
	)

	if (tokenInformation) {
		log(`Is contract verified: TRUE`, logType.ok)
		log(`Contract name: ${tokenInformation.ContractName}`, logType.ok)
		log(`Compiler version: ${tokenInformation.CompilerVersion}`, logType.ok)
		log(`Runs: ${tokenInformation.Runs}\n`, logType.ok)
	} else {
		log(`Is contract verified: FALSE\n`, logType.danger)
	}

	if (balanceWBNBOfUser.lt(configs.amountOfWBNB)) {
		log(`Validation error: balance of amount WBNB is less than user WBNB balance`, logType.danger)
		log('exiting..\n', logType.ok)
		process.exit(1)
	}

	if (honeypotChecker) {
		log(`Honeypot checker..`, logType.ok)
		log(
			`No liquidity: ${honeypotChecker.NoLiquidity}`,
			honeypotChecker.NoLiquidity ? logType.ok : logType.danger
		)
		log(
			`Is honeypot: ${honeypotChecker.IsHoneypot}`,
			honeypotChecker.IsHoneypot ? logType.danger : logType.ok
		)
		log(
			`Buy tax: ${honeypotChecker.BuyTax}%`,
			honeypotChecker.BuyTax > configs.maxBuyTax ? logType.danger : logType.ok
		)
		log(
			`Sell tax: ${honeypotChecker.SellTax}%\n`,
			honeypotChecker.SellTax > configs.maxSellTax ? logType.danger : logType.ok
		)
	}

	if (!isWBNBApproved) {
		log('WBNB is no approved', logType.ok)
		log('approving WBNB..', logType.ok)
		let txApprove
		try {
			txApprove = await _approveWBNB()
		} catch (error) {
			// TODO proper handle error transaction
			const txError = JSON.parse(JSON.stringify(error))
			log(`Error TX approve WBNB: ${txError.transactionHash} | ${txError.reason}`, logType.danger)
			log('exiting..\n', logType.ok)
			return
		}
		log(`TX approve WBNB success: ${txApprove.hash}\n`, logType.ok)
	}
	if (!isTargetTokenApproved) {
		log('Target token is no approved', logType.ok)
		log('approving target token..', logType.ok)
		let txApprove
		try {
			txApprove = await _approveTargetToken()
		} catch (error) {
			// TODO proper handle error transaction
			const txError = JSON.parse(JSON.stringify(error))
			log(`Error TX approve WBNB: ${txError.transactionHash} | ${txError.reason}`, logType.danger)
			log('exiting..\n', logType.ok)
			return
		}
		log(`TX approve target token success: ${txApprove.hash}\n`, logType.ok)
	}
}

const main = async () => {
	await startUp()
	await confirmYesNo('Continue process the target?')

	log(`Auto sell is ON`, logType.ok)
	autoSell()

	log(`Detecting target token liquidity..`, logType.ok)
	detectLiquidity()
}

main()
