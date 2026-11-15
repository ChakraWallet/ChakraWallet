// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// The router the simulated aggregator sends swaps to: fixed rates, paid from its own balance. Like a real router it
/// pulls the input token with transferFrom, so a swap of a token needs the wallet's approval first.
contract TestDex {
    using SafeERC20 for IERC20;
    address public constant NATIVE = address(0);
    mapping(address => mapping(address => uint256)) public rate; // tokenIn => tokenOut => output per input unit, 1e18-scaled

    event Swapped(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    receive() external payable {}

    function setRate(address tokenIn, address tokenOut, uint256 rate18) external { rate[tokenIn][tokenOut] = rate18; }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        return amountIn * rate[tokenIn][tokenOut] / 1e18;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to) external payable returns (uint256 out) {
        require(rate[tokenIn][tokenOut] > 0, "no pair");
        if (tokenIn == NATIVE) require(msg.value == amountIn, "value");
        else IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        out = quote(tokenIn, tokenOut, amountIn);
        require(out >= minOut, "slippage");
        if (tokenOut == NATIVE) { (bool ok,) = to.call{value: out}(""); require(ok, "pay"); }
        else IERC20(tokenOut).safeTransfer(to, out);
        emit Swapped(msg.sender, tokenIn, tokenOut, amountIn, out);
    }
}
