// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// The deposit side of the simulated bridge: funds stay here, a relayer (e2e/env/services.mjs) watches Deposit and
/// pays the recipient on the destination network.
contract TestBridge {
    using SafeERC20 for IERC20;

    event Deposit(bytes32 indexed requestId, address indexed from, address token, uint256 amount, uint256 destChainId, address recipient);

    function deposit(bytes32 requestId, address token, uint256 amount, uint256 destChainId, address recipient) external payable {
        if (token == address(0)) require(msg.value == amount, "value");
        else IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposit(requestId, msg.sender, token, amount, destChainId, recipient);
    }
}
